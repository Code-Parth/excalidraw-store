import { Storage } from "@google-cloud/storage";
import cors from "cors";
import express from "express";
import { nanoid } from "nanoid";
import favicon from "serve-favicon";
import * as fs from "fs";
import * as path from "path";

const PROJECT_NAME = process.env.GOOGLE_CLOUD_PROJECT || "excalidraw-json-dev";
const PROD = PROJECT_NAME === "excalidraw-json";
const LOCAL = process.env.NODE_ENV !== "production";
const BUCKET_NAME = PROD
  ? "excalidraw-json.appspot.com"
  : "excalidraw-json-dev.appspot.com";

/** Use local disk when STORAGE_BACKEND=local (Docker / offline). */
const USE_LOCAL_STORAGE =
  process.env.STORAGE_BACKEND === "local" ||
  process.env.STORAGE_BACKEND === "filesystem";

const LOCAL_DATA_DIR =
  process.env.LOCAL_STORAGE_PATH || path.join(process.cwd(), "data");

const FILE_SIZE_LIMIT = 2 * 1024 * 1024;

type BlobBackend = {
  getReadStream: (key: string) => Promise<{ pipe: (dest: any) => any }>;
  createWriteStream: (key: string) => {
    write: (chunk: any) => boolean;
    end: () => void;
    destroy: () => void;
    on: (event: string, cb: (...args: any[]) => void) => any;
  };
};

function createGcsBackend(): BlobBackend {
  const storage = new Storage(
    LOCAL
      ? {
          projectId: PROJECT_NAME,
          keyFilename: `${__dirname}/keys/${PROJECT_NAME}.json`,
        }
      : undefined
  );
  const bucket = storage.bucket(BUCKET_NAME);
  return {
    async getReadStream(key) {
      const file = bucket.file(key);
      await file.getMetadata();
      return file.createReadStream();
    },
    createWriteStream(key) {
      return bucket.file(key).createWriteStream({ resumable: false });
    },
  };
}

function createLocalBackend(dataDir: string): BlobBackend {
  fs.mkdirSync(dataDir, { recursive: true });
  return {
    async getReadStream(key) {
      // Prevent path traversal — keys are nanoid ids.
      if (!/^[A-Za-z0-9_-]+$/.test(key)) {
        throw new Error("Invalid key");
      }
      const filePath = path.join(dataDir, key);
      await fs.promises.access(filePath, fs.constants.R_OK);
      return fs.createReadStream(filePath);
    },
    createWriteStream(key) {
      if (!/^[A-Za-z0-9_-]+$/.test(key)) {
        throw new Error("Invalid key");
      }
      return fs.createWriteStream(path.join(dataDir, key));
    },
  };
}

const backend: BlobBackend = USE_LOCAL_STORAGE
  ? createLocalBackend(LOCAL_DATA_DIR)
  : createGcsBackend();

if (USE_LOCAL_STORAGE) {
  console.log(`Using local filesystem storage at ${LOCAL_DATA_DIR}`);
}

const app = express();

let allowOrigins = [
  "excalidraw.vercel.app",
  "https://dai-shi.github.io",
  "https://excalidraw.com",
  "https://www.excalidraw.com",
  "https://math.preview.excalidraw.com",
  "http://localhost",
  "http://127.0.0.1",
];
if (!PROD || USE_LOCAL_STORAGE) {
  allowOrigins.push("http://localhost:");
}

const corsGet = cors();
const corsPost = cors((req, callback) => {
  const origin = req.headers.origin;
  let isGood = false;
  if (origin) {
    for (const allowOrigin of allowOrigins) {
      if (origin.indexOf(allowOrigin) >= 0) {
        isGood = true;
        break;
      }
    }
  } else if (USE_LOCAL_STORAGE) {
    // Allow non-browser / same-origin clients in local mode
    isGood = true;
  }
  callback(null, { origin: isGood });
});

app.use(favicon(path.join(__dirname, "favicon.ico")));
app.get("/", (req, res) => res.sendFile(`${process.cwd()}/index.html`));

app.get("/health", (_req, res) => {
  res.status(200).json({
    ok: true,
    storage: USE_LOCAL_STORAGE ? "local" : "gcs",
  });
});

app.get("/api/v2/:key", corsGet, async (req, res) => {
  try {
    const key = req.params.key;
    const stream = await backend.getReadStream(key);
    res.status(200);
    res.setHeader("content-type", "application/octet-stream");
    stream.pipe(res);
  } catch (error) {
    console.error(error);
    res.status(404).json({ message: "Could not find the file." });
  }
});

app.post("/api/v2/post/", corsPost, (req, res) => {
  try {
    let fileSize = 0;
    const id = nanoid();
    const blobStream = backend.createWriteStream(id);

    blobStream.on("error", (error) => {
      console.error(error);
      res.status(500).json({ message: error.message });
    });

    blobStream.on("finish", async () => {
      res.status(200).json({
        id,
        data: `${LOCAL || USE_LOCAL_STORAGE ? "http" : "https"}://${req.get(
          "host"
        )}/api/v2/${id}`,
      });
    });

    req.on("data", (chunk) => {
      blobStream.write(chunk);
      fileSize += chunk.length;
      if (fileSize > FILE_SIZE_LIMIT) {
        const error = {
          message: "Data is too large.",
          max_limit: FILE_SIZE_LIMIT,
        };
        blobStream.destroy();
        console.error(error);
        return res.status(413).json(error);
      }
    });
    req.on("end", () => {
      blobStream.end();
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Could not upload the data." });
  }
});

const port = process.env.PORT || 8080;
app.listen(port, () => console.log(`http://localhost:${port}`));
