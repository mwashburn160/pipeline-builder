# Prettier Plugin — Code Formatting Checker
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# Verifies code formatting across JS, TS, CSS, HTML, JSON, YAML, Markdown
# Check-only mode (does not modify files in CI)
#
# Thin layer over pipeline-node-base (one pinned Node 24 + npm). Prettier is
# pinned + baked at build time — no runtime `npm install -g`. A project that
# pins its own Prettier still wins via `npx` (local resolves before global).

FROM pipeline-node-base:1.0

# TODO(confirm): pin the intended Prettier version at build time.
ARG PRETTIER_VERSION=3.4.2
RUN npm install -g "prettier@${PRETTIER_VERSION}"

WORKDIR /app
CMD ["bash"]
