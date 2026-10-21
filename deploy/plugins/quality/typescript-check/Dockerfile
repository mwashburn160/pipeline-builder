# TypeScript Check Plugin — Type Verification
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
#
# Thin layer over plugin-node-base (one pinned Node 24 + npm). TypeScript
# (the `tsc` CLI) is pinned + baked at build time — no runtime `npm install
# -g`. A project that pins its own TypeScript still wins via `npx`.

FROM plugin-node-base:1.0

# TypeScript 7 — the native (Go) compiler. Deliberately ahead of the monorepo,
# which holds the 6.x API because ts-jest crashes under 7; that constraint is
# about ts-jest and does not reach a plugin that only runs the `tsc` CLI.
#
# This is a MAJOR for the projects being checked: a repo that type-checks clean
# under 6 can fail under 7, which surfaces as a pipeline going red rather than
# as anything wrong with the plugin. A project that pins its own TypeScript
# still wins via `npx`, so that is the escape hatch.
ARG TYPESCRIPT_VERSION=7.0.2
RUN npm install -g "typescript@${TYPESCRIPT_VERSION}"

WORKDIR /app
USER 1000:1000
CMD ["bash"]
