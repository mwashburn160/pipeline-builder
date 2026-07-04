# Postman Plugin — API Contract Testing via Newman
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# Runs Postman collections using Newman CLI
# Supports environment files, global variables, and multiple reporters
#
# Thin layer over pipeline-node-base (one pinned Node 24 + npm). Newman and
# its reporters are pinned + baked at build time — no runtime `npm install -g`.

FROM pipeline-node-base:1.0

# ─── Newman (Postman CLI runner) + reporters — pinned + baked ───
RUN npm install -g newman@6.2.1 \
    newman-reporter-htmlextra@1.23.1 \
    newman-reporter-junitfull@1.1.1

# ─── Runtime configuration defaults ───
ENV COLLECTION_FILE=""
ENV ENVIRONMENT_FILE=""
ENV GLOBALS_FILE=""
ENV ITERATION_COUNT=1
ENV NEWMAN_TIMEOUT=60000
ENV BAIL_ON_FAILURE=false

WORKDIR /app
CMD ["bash"]
