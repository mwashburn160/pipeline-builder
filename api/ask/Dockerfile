ARG NODE_VERSION=24.14.0

# CA certificates stage — shared base with self-signed cert trust
FROM node:${NODE_VERSION}-alpine AS certs
RUN apk update && apk add ca-certificates --no-cache
COPY ./self-signed.crt /usr/local/share/ca-certificates/self-signed.crt
RUN update-ca-certificates 2>/dev/null

# Production stage
# F-0.3: node_modules is built OUTSIDE Docker by the docker:build script
# (`pnpm deploy --filter <name> --prod --legacy .docker-build`) so the
# install runs against pnpm-lock.yaml. The .docker-build/ tree carries a
# lockfile-locked, prod-only dep set; this stage just copies it in.
# Closes the caret-range drift trap that bit jest in May 2026: a Docker
# rebuild can no longer pull a newer caret-compatible version of any
# dep behind the platform's back.
FROM node:${NODE_VERSION}-alpine
RUN apk add --no-cache curl
COPY --from=certs /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt

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