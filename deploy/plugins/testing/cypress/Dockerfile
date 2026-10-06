# Cypress Plugin — End-to-End Browser Testing
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# Runs Cypress E2E tests with video recording and screenshot capture
#
# Thin layer over plugin-node-base (one pinned Node 24 + npm). Cypress is
# pinned + baked at build time (its browser binary is downloaded here) — no
# runtime `npm install -g`. A project that pins its own Cypress still wins via
# `npx`. Browser system libraries (below) are Cypress-specific and kept.

FROM plugin-node-base:1.0

# apt needs root; the npm install below runs as uid 1000 again.
USER root

# Cypress browser prerequisites (system libs for the bundled Electron/Chromium).
RUN apt-retry-install libgtk2.0-0 libgtk-3-0 libgbm-dev libnotify-dev libnss3 libxss1 libasound2t64 libxtst6 xauth xvfb fonts-liberation

# Cypress binary cache in a fixed, shared location (the default ~/.cache/Cypress
# is per-user, so a binary cached for one user is invisible to another).
ENV CYPRESS_CACHE_FOLDER=/opt/cypress-cache
RUN install -d -o 1000 -g 1000 "${CYPRESS_CACHE_FOLDER}"

# Installed as uid 1000 into the base's uid-1000-owned Node prefix.
USER 1000:1000

# TODO(confirm): pin the intended Cypress version at build time.
# 16.1.1 fixes three dependency CVEs present in 16.1.0: node-forge
# (CVE-2026-33896), form-data CRLF injection (CVE-2026-12143), and
# proxy-addr user impersonation (CVE-2026-90711).
ARG CYPRESS_VERSION=16.1.1

# Cypress 16.1.1 IS the current release, so the Criticals the gate reports —
# simple-git, lodash, braces, ansi-regex — cannot be cleared by bumping it.
# They are pinned by Cypress's own dependency tree, so they are overridden.#
# A LOCAL install under /opt, because `npm install -g` ignores `overrides`
# outright. The bin symlinks are made as root up front and dangle until the
# install lands. The build FAILS if an override did not take: npm applies one
# silently or not at all, and the image would otherwise ship the vulnerable
# version while looking fixed.
ARG CYPRESS_SIMPLE_GIT_VERSION=4.0.2
ARG CYPRESS_LODASH_VERSION=4.18.1
ARG CYPRESS_BRACES_VERSION=3.0.3
ARG CYPRESS_ANSI_REGEX_VERSION=6.4.0
# root for the dir + the /usr/local/bin symlinks; the install itself is uid 1000.
USER root
RUN install -d -o 1000 -g 1000 /opt/cypress \
    && ln -s /opt/cypress/node_modules/.bin/cypress /usr/local/bin/cypress
USER 1000:1000
RUN set -eux; \
    cd /opt/cypress; \
    npm init -y >/dev/null; \
    npm pkg set overrides.simple-git="${CYPRESS_SIMPLE_GIT_VERSION}"; \
    npm pkg set overrides.lodash="${CYPRESS_LODASH_VERSION}"; \
    npm pkg set overrides.braces="${CYPRESS_BRACES_VERSION}"; \
    npm pkg set overrides.ansi-regex="${CYPRESS_ANSI_REGEX_VERSION}"; \
    npm install --omit=dev "cypress@${CYPRESS_VERSION}"; \
    node -e "for (const [p, want] of [['simple-git','${CYPRESS_SIMPLE_GIT_VERSION}'],['lodash','${CYPRESS_LODASH_VERSION}'],['braces','${CYPRESS_BRACES_VERSION}'],['ansi-regex','${CYPRESS_ANSI_REGEX_VERSION}']]) { const v = require('/opt/cypress/node_modules/' + p + '/package.json').version; if (v !== want) { console.error(p + ' resolved to ' + v + ', wanted ' + want); process.exit(1); } console.log(p + ' ok: ' + v); }"; \
    cypress --version
USER root

WORKDIR /app
USER 1000:1000
CMD ["bash"]
