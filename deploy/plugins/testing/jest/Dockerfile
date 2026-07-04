# Jest Plugin — JavaScript/TypeScript Test Runner
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
#
# Thin layer over pipeline-node-base (one pinned Node 24 + npm). Jest and the
# jest-junit reporter are pinned + baked at build time — no runtime
# `npm install -g`. A project that pins its own Jest still wins via `npx`.

FROM pipeline-node-base:1.0

# TODO(confirm): pin the intended Jest / jest-junit versions at build time.
ARG JEST_VERSION=29.7.0
ARG JEST_JUNIT_VERSION=16.0.0
RUN npm install -g "jest@${JEST_VERSION}" "jest-junit@${JEST_JUNIT_VERSION}"

WORKDIR /app
CMD ["bash"]
