# Node.js Build Plugin — Build Verification
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
#
# Thin layer over pipeline-node-base (one pinned Node 24 + npm, shared by all
# Node plugins). No per-plugin tool is baked: this plugin runs the user
# project's own build script via npm/yarn/pnpm.

FROM pipeline-node-base:1.0

WORKDIR /app
CMD ["bash"]
