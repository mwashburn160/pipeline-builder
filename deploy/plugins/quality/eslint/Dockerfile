# ESLint Plugin — JavaScript/TypeScript Linting
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
#
# Thin layer over pipeline-node-base (one pinned Node 24 + npm). ESLint is
# pinned + baked at build time — no runtime `npm install -g` (deterministic,
# no network dependency at pipeline time). A project that pins its own ESLint
# still wins via `npx` (a local install resolves before this global fallback).

FROM pipeline-node-base:1.0

# TODO(confirm): pin the intended ESLint version at build time.
ARG ESLINT_VERSION=9.15.0
RUN npm install -g "eslint@${ESLINT_VERSION}"

WORKDIR /app
CMD ["bash"]
