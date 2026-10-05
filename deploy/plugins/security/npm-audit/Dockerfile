# npm Audit Plugin — Dependency Vulnerability Scanning
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
#
# Thin layer over plugin-node-base (one pinned Node 24 + npm, shared by all
# Node plugins). No per-plugin tool is baked: the audit uses the package
# manager's own `audit` subcommand (npm baked; yarn/pnpm from the project).

FROM plugin-node-base:1.0

WORKDIR /app
USER 1000:1000
CMD ["bash"]
