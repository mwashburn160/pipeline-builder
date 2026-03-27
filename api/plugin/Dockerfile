ARG NODE_VERSION=24.14.0

# Kaniko executor for daemonless builds (used when no Docker daemon available)
FROM gcr.io/kaniko-project/executor:v1.23.2 AS kaniko

# Build stage — install production dependencies only
FROM node:${NODE_VERSION}-alpine AS deps
WORKDIR /app
COPY package.json .
RUN --mount=type=secret,id=npmrc,target=.npmrc npm install --omit=dev

# Production stage
# NOTE: Runs as root because Kaniko requires root to manipulate filesystem
# ownership during image builds (chown to root). This is the only service
# that requires root — all others run as non-root (node).
FROM node:${NODE_VERSION}-alpine
RUN apk update && \
    apk add ca-certificates curl docker-cli docker-cli-buildx --no-cache
COPY ./self-signed.crt /usr/local/share/ca-certificates/self-signed.crt
RUN update-ca-certificates
COPY --from=kaniko /kaniko/executor /kaniko/executor
COPY --from=kaniko /kaniko/ssl/certs/ca-certificates.crt /kaniko/ssl/certs/
RUN mkdir -p /kaniko/cache /kaniko/.docker

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json .
COPY lib/ /app
RUN mkdir -p /app/tmp /app/uploads

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:3000/health || exit 1

CMD ["node", "index.js"]
