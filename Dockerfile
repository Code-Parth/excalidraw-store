# Optional standalone Dockerfile for excalidraw-store (local disk backend).
# Prefer the all-in-one image under ../docker-all-in-one/ for the full stack.

FROM node:24-bookworm AS build
WORKDIR /opt/store
COPY package.json yarn.lock ./
RUN yarn --frozen-lockfile --ignore-scripts --network-timeout 600000
COPY . .
RUN yarn build

FROM node:24-bookworm-slim
WORKDIR /opt/store
COPY --from=build /opt/store/index.js /opt/store/index.html /opt/store/favicon.ico ./
ENV NODE_ENV=production \
    STORAGE_BACKEND=local \
    LOCAL_STORAGE_PATH=/data \
    PORT=8080
VOLUME ["/data"]
EXPOSE 8080
CMD ["node", "index.js"]
