ARG NODE_VERSION=24.14.0
ARG BUILDKIT_VERSION=v0.16.0
ARG CRANE_VERSION=v0.20.2

# =============================================================================
# Plugin service image.
#
# Builds run against a rootless buildkitd sidecar; this image only carries the
# `buildctl` client. The single dockerd/podman/kaniko strategy switch is gone —
# every deploy target uses the same code path now.
# =============================================================================

FROM node:${NODE_VERSION}-slim AS tools
ARG BUILDKIT_VERSION
ARG CRANE_VERSION
# buildctl: connects to the rootless buildkitd sidecar to run the actual build.
# crane:    pushes prebuilt `docker save` tarballs (buildctl cannot do that).
# Both download as static Linux binaries from upstream GitHub releases —
# pinning a version of each gives reproducible builds without depending on
# gcr.io image-tag conventions.
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && curl -fsSL "https://github.com/moby/buildkit/releases/download/${BUILDKIT_VERSION}/buildkit-${BUILDKIT_VERSION}.linux-amd64.tar.gz" \
        | tar -xz -C /usr/local bin/buildctl \
    && curl -fsSL "https://github.com/google/go-containerregistry/releases/download/${CRANE_VERSION}/go-containerregistry_Linux_x86_64.tar.gz" \
        | tar -xz -C /usr/local/bin crane

FROM node:${NODE_VERSION}-slim
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=tools /usr/local/bin/buildctl /usr/local/bin/buildctl
COPY --from=tools /usr/local/bin/crane /usr/local/bin/crane
WORKDIR /app
# F-0.3: node_modules is built OUTSIDE Docker by the docker:build script
# (`pnpm deploy --filter plugin --prod --legacy .docker-build`) so the
# install runs against pnpm-lock.yaml. The deps stage that used
# `npm install --omit=dev` was removed — caret-range drift on rebuild
# is no longer possible.
COPY .docker-build/node_modules ./node_modules
COPY .docker-build/package.json .
COPY .docker-build/lib/ /app
RUN mkdir -p /app/tmp /app/uploads && chown -R node:node /app/tmp /app/uploads
USER node
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:3000/health || exit 1
CMD ["node", "--import", "@pipeline-builder/api-server/lib/otel-bootstrap.js", "index.js"]