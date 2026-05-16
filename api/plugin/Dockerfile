ARG NODE_VERSION=24.14.0
ARG BUILDKIT_VERSION=v0.16.0

# =============================================================================
# Plugin service image.
#
# Builds run against a rootless buildkitd sidecar; this image only carries the
# `buildctl` client. The single dockerd/podman/kaniko strategy switch is gone —
# every deploy target uses the same code path now.
# =============================================================================

FROM node:${NODE_VERSION}-slim AS deps
WORKDIR /app
COPY package.json .
RUN --mount=type=secret,id=npmrc,target=.npmrc npm install --omit=dev

FROM node:${NODE_VERSION}-slim AS buildctl
ARG BUILDKIT_VERSION
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && curl -fsSL "https://github.com/moby/buildkit/releases/download/${BUILDKIT_VERSION}/buildkit-${BUILDKIT_VERSION}.linux-amd64.tar.gz" \
        | tar -xz -C /usr/local --strip-components=1 ./bin/buildctl

# crane is used only for the prebuilt-tar push path (`buildctl` can build but
# cannot push a `docker save` tarball directly). ~12MB single binary.
FROM gcr.io/go-containerregistry/crane:v0.20.2 AS crane

FROM node:${NODE_VERSION}-slim
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=buildctl /usr/local/bin/buildctl /usr/local/bin/buildctl
COPY --from=crane /ko-app/crane /usr/local/bin/crane
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json .
COPY lib/ /app
RUN mkdir -p /app/tmp /app/uploads && chown -R node:node /app/tmp /app/uploads
USER node
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:3000/health || exit 1
CMD ["node", "index.js"]
