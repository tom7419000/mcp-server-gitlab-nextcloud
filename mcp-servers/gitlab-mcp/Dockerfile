# syntax=docker/dockerfile:1
# node:20-alpine is an official multi-arch image (amd64/arm64/arm/v7),
# so this builds unmodified on a Raspberry Pi (ARM64) as well as on x86
# dev machines. No native (node-gyp) dependencies are used, so no extra
# build toolchain is needed in the builder stage.

FROM node:20-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=builder --chown=node:node /app/dist ./dist

# node:20-alpine already ships a non-root "node" user (uid/gid 1000).
USER node

EXPOSE 3001

# Uses busybox wget (built into alpine, no extra package needed) so this
# works even with a read-only root filesystem and no curl installed.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${GITLAB_MCP_PORT:-3001}/health" || exit 1

CMD ["node", "dist/index.js"]
