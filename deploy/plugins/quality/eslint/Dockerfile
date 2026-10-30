# ESLint Plugin — JavaScript/TypeScript Linting
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
#
# Thin layer over plugin-node-base (one pinned Node 26 + npm). ESLint is
# pinned + baked at build time — no runtime `npm install -g` (deterministic,
# no network dependency at pipeline time). A project that pins its own ESLint
# still wins via `npx` (a local install resolves before this global fallback).

FROM plugin-node-base:1.0

ARG ESLINT_VERSION=10.14.0
RUN npm install -g "eslint@${ESLINT_VERSION}"

WORKDIR /app
USER 1000:1000
CMD ["bash"]
