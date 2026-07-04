# Node.js Plugin — build/test JavaScript & TypeScript projects
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
#
# Thin layer over pipeline-node-base (one pinned Node 24 + npm, shared by all
# Node plugins). No per-plugin tool is baked: this language plugin runs the
# user project's own build/test via npm/yarn/pnpm. Package manager is
# auto-detected (npm/yarn/pnpm) or set via the PACKAGE_MANAGER env var.

FROM pipeline-node-base:1.0

WORKDIR /app
CMD ["bash"]
