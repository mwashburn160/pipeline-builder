# TypeScript Check Plugin — Type Verification
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
#
# Thin layer over pipeline-node-base (one pinned Node 24 + npm). TypeScript
# (the `tsc` CLI) is pinned + baked at build time — no runtime `npm install
# -g`. A project that pins its own TypeScript still wins via `npx`.

FROM pipeline-node-base:1.0

# TODO(confirm): pin the intended TypeScript version at build time.
ARG TYPESCRIPT_VERSION=5.7.2
RUN npm install -g "typescript@${TYPESCRIPT_VERSION}"

WORKDIR /app
CMD ["bash"]
