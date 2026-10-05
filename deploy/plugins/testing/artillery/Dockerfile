# Artillery Plugin — HTTP and WebSocket Load Testing
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# Runs Artillery load tests with configurable scenarios
#
# Thin layer over plugin-node-base (one pinned Node 24 + npm). The Artillery
# CLI is pinned + baked at build time — no runtime `npm install -g`.

FROM plugin-node-base:1.0

# TODO(confirm): pin the intended Artillery version at build time.
# VULN SCAN (2026-10-02): 2.0.34 (already the latest release) pulls in
# vulnerable transitive deps — csv-parse 4.16.3 (prototype-replacement via
# columns path, fixed upstream at 7.0.2) and brace-expansion <1.1.16 (ReDoS).
# No newer Artillery release exists yet that bumps either; re-check on the
# next scan whether a fix has shipped before assuming this is still open.
ARG ARTILLERY_VERSION=2.0.34
RUN npm install -g "artillery@${ARTILLERY_VERSION}"

WORKDIR /app
USER 1000:1000
CMD ["bash"]
