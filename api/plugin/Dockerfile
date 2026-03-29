ARG NODE_VERSION=24.14.0

# =============================================================================
# Shared stages
# =============================================================================

# Kaniko executor binary (used by kaniko-target only)
FROM gcr.io/kaniko-project/executor:v1.23.2 AS kaniko

# CA certificates with self-signed cert trust
FROM node:${NODE_VERSION}-slim AS certs
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY ./self-signed.crt /usr/local/share/ca-certificates/self-signed.crt
RUN update-ca-certificates 2>/dev/null

# Production dependencies
FROM node:${NODE_VERSION}-slim AS deps
WORKDIR /app
COPY package.json .
RUN --mount=type=secret,id=npmrc,target=.npmrc npm install --omit=dev

# Shared app base: certs + curl + app code
FROM node:${NODE_VERSION}-slim AS app-base
RUN apt-get update && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*
COPY --from=certs /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json .
COPY lib/ /app
RUN mkdir -p /app/tmp /app/uploads && chown -R node:node /app/tmp /app/uploads
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:3000/health || exit 1

# =============================================================================
# kaniko-target — daemonless builds for Fargate (runs as root)
# =============================================================================

FROM app-base AS kaniko-target
COPY --from=kaniko /kaniko/executor /kaniko/executor
COPY --from=certs /etc/ssl/certs/ca-certificates.crt /kaniko/ssl/certs/ca-certificates.crt
RUN mkdir -p /kaniko/cache /kaniko/.docker
CMD ["node", "index.js"]

# =============================================================================
# podman-target — rootless builds for k8s/local (runs as node)
# =============================================================================

FROM app-base AS podman-target
RUN apt-get update && apt-get install -y --no-install-recommends \
    podman fuse-overlayfs slirp4netns uidmap \
    && rm -rf /var/lib/apt/lists/*
# Podman rootless config
COPY containers.conf /etc/containers/containers.conf
COPY storage.conf /etc/containers/storage.conf
# Self-signed cert for Podman registry access
RUN mkdir -p /etc/containers/certs.d
COPY ./self-signed.crt /etc/containers/certs.d/self-signed.crt
# Storage directory for rootless builds
RUN mkdir -p /home/node/.local/share/containers/storage \
    && chown -R node:node /home/node/.local
USER node
CMD ["node", "index.js"]

# =============================================================================
# docker-target — Docker daemon builds for development (runs as node)
# =============================================================================

FROM app-base AS docker-target
RUN apt-get update && apt-get install -y --no-install-recommends \
    docker.io \
    && rm -rf /var/lib/apt/lists/*
USER node
CMD ["node", "index.js"]
