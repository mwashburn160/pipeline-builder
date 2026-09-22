# Base image pinned BY DIGEST (tag kept for readers): a re-pushed or
# compromised tag cannot change what a release image is built from. Bump both
# together (docker buildx imagetools inspect node:<ver>-alpine).
ARG NODE_IMAGE=node:24.14.0-alpine@sha256:7fddd9ddeae8196abf4a3ef2de34e11f7b1a722119f91f28ddf1e99dcafdf114

# Production stage
# F-0.3: node_modules is built OUTSIDE Docker by the docker:build script
# (`pnpm deploy --filter <name> --prod --legacy .docker-build`) so the
# install runs against pnpm-lock.yaml. The .docker-build/ tree carries a
# lockfile-locked, prod-only dep set; this stage just copies it in.
# Closes the caret-range drift trap that bit jest in May 2026: a Docker
# rebuild can no longer pull a newer caret-compatible version of any
# dep behind the platform's back.
FROM ${NODE_IMAGE}
RUN apk add --no-cache curl

WORKDIR /app
COPY --chown=node:node .docker-build/node_modules ./node_modules
COPY --chown=node:node .docker-build/package.json .
COPY --chown=node:node .docker-build/lib/ /app

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:3000/health || exit 1

USER node
CMD ["node", "--import", "@pipeline-builder/api-server/lib/otel-bootstrap.js", "index.js"]