# Postman Plugin — API Contract Testing via Newman
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# Runs Postman collections using Newman CLI
# Supports environment files, global variables, and multiple reporters
#
# Thin layer over plugin-node-base (one pinned Node 24 + npm). Newman and
# its reporters are pinned + baked at build time — no runtime `npm install -g`.

FROM plugin-node-base:1.0

# ─── Newman (Postman CLI runner) + reporters — pinned + baked ───
# newman 6.2.2 IS the current release, so the Criticals the gate reports —
# handlebars, lodash, underscore, flatted — cannot be cleared by bumping it.
# They are pinned by newman's own dependency tree, so they are overridden.#
# A LOCAL install under /opt, because `npm install -g` ignores `overrides`
# outright. The bin symlinks are made as root up front and dangle until the
# install lands. The build FAILS if an override did not take: npm applies one
# silently or not at all, and the image would otherwise ship the vulnerable
# version while looking fixed.
ARG NEWMAN_VERSION=6.2.2
ARG NEWMAN_HANDLEBARS_VERSION=4.7.10
ARG NEWMAN_LODASH_VERSION=4.18.1
ARG NEWMAN_UNDERSCORE_VERSION=1.13.8
ARG NEWMAN_FLATTED_VERSION=3.4.4
# root for the dir + the /usr/local/bin symlinks; the install itself is uid 1000.
USER root
RUN install -d -o 1000 -g 1000 /opt/newman \
    && ln -s /opt/newman/node_modules/.bin/newman /usr/local/bin/newman
USER 1000:1000
RUN set -eux; \
    cd /opt/newman; \
    npm init -y >/dev/null; \
    npm pkg set overrides.handlebars="${NEWMAN_HANDLEBARS_VERSION}"; \
    npm pkg set overrides.lodash="${NEWMAN_LODASH_VERSION}"; \
    npm pkg set overrides.underscore="${NEWMAN_UNDERSCORE_VERSION}"; \
    npm pkg set overrides.flatted="${NEWMAN_FLATTED_VERSION}"; \
    npm install --omit=dev "newman@${NEWMAN_VERSION}" \
      newman-reporter-htmlextra@1.23.1 \
      newman-reporter-junitfull@1.1.1; \
    node -e "for (const [p, want] of [['handlebars','${NEWMAN_HANDLEBARS_VERSION}'],['lodash','${NEWMAN_LODASH_VERSION}'],['underscore','${NEWMAN_UNDERSCORE_VERSION}'],['flatted','${NEWMAN_FLATTED_VERSION}']]) { const v = require('/opt/newman/node_modules/' + p + '/package.json').version; if (v !== want) { console.error(p + ' resolved to ' + v + ', wanted ' + want); process.exit(1); } console.log(p + ' ok: ' + v); }"; \
    newman --version
USER root

# ─── Runtime configuration defaults ───
ENV COLLECTION_FILE=""
ENV ENVIRONMENT_FILE=""
ENV GLOBALS_FILE=""
ENV ITERATION_COUNT=1
ENV NEWMAN_TIMEOUT=60000
ENV BAIL_ON_FAILURE=false

WORKDIR /app
USER 1000:1000
CMD ["bash"]
