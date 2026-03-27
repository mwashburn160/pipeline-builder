ARG NODE_VERSION=24.14.0

# Kaniko executor for daemonless builds (used when no Docker daemon available)
FROM gcr.io/kaniko-project/executor:v1.23.2 AS kaniko

# Build stage — install production dependencies only
FROM node:${NODE_VERSION}-alpine AS deps
WORKDIR /app
COPY package.json .
RUN --mount=type=secret,id=npmrc,target=.npmrc npm install --omit=dev

# Production stage
FROM node:${NODE_VERSION}-alpine
RUN apk update && \
    apk add ca-certificates curl docker-cli docker-cli-buildx --no-cache
COPY ./self-signed.crt /usr/local/share/ca-certificates/self-signed.crt
RUN update-ca-certificates
COPY --from=kaniko /kaniko/executor /kaniko/executor
COPY --from=kaniko /kaniko/ssl/certs/ca-certificates.crt /kaniko/ssl/certs/
RUN mkdir -p /kaniko/cache /kaniko/.docker && chown -R node:node /kaniko/cache /kaniko/.docker

WORKDIR /app
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json .
COPY --chown=node:node lib/ /app
RUN mkdir -p /app/tmp /app/uploads && chown -R node:node /app/tmp /app/uploads

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:3000/health || exit 1

USER node
CMD ["node", "index.js"]
