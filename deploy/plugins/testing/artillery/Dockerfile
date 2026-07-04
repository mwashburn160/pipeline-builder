# Artillery Plugin — HTTP and WebSocket Load Testing
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# Runs Artillery load tests with configurable scenarios
#
# Thin layer over pipeline-node-base (one pinned Node 24 + npm). The Artillery
# CLI is pinned + baked at build time — no runtime `npm install -g`.

FROM pipeline-node-base:1.0

# TODO(confirm): pin the intended Artillery version at build time.
ARG ARTILLERY_VERSION=2.0.21
RUN npm install -g "artillery@${ARTILLERY_VERSION}"

WORKDIR /app
CMD ["bash"]
