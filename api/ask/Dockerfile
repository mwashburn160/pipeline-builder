# Base image pinned BY DIGEST (tag kept for readers): a re-pushed or
# compromised tag cannot change what a release image is built from. Bump both
# together (docker buildx imagetools inspect node:<ver>-alpine).
ARG NODE_IMAGE=node:24.21.0-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1

# Production stage
# F-0.3: node_modules is built OUTSIDE Docker by the docker:build script
# (`pnpm deploy --filter <name> --prod --legacy .docker-build`) so the
# install runs against pnpm-lock.yaml. The .docker-build/ tree carries a
# lockfile-locked, prod-only dep set; this stage just copies it in.
# Closes the caret-range drift trap that bit jest in May 2026: a Docker
# rebuild can no longer pull a newer caret-compatible version of any
# dep behind the platform's back.
FROM ${NODE_IMAGE}
# Runtime hardening: pull the latest patched OS packages (the base digest can lag
# an openssl/musl/zlib fix) and drop the npm/corepack/yarn CLIs the image never runs —
# they ship their own dependency trees (tar, pacote, sigstore, minimatch …) that the
# release grype gate would otherwise flag.
RUN apk upgrade --no-cache \
    && apk add --no-cache curl \
    && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
       /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
       /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-*

WORKDIR /app
COPY --chown=node:node .docker-build/node_modules ./node_modules
COPY --chown=node:node .docker-build/package.json .
COPY --chown=node:node .docker-build/lib/ /app

# Grounding corpus for the "Ask" agent's how-to answers. The docker:build script
# stages the repo's docs/ into ./docs (the build context is the service dir), and
# ASK_DOCS_DIR points the service at the bundled copy. Without this the docs index
# is empty and the assistant can't answer how-to questions.
COPY --chown=node:node docs/ /app/docs
ENV ASK_DOCS_DIR=/app/docs

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:3000/health || exit 1

USER node
CMD ["node", "--import", "@pipeline-builder/api-server/lib/otel-bootstrap.js", "index.js"]