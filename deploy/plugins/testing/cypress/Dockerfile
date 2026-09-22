# Cypress Plugin — End-to-End Browser Testing
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# Runs Cypress E2E tests with video recording and screenshot capture
#
# Thin layer over pipeline-node-base (one pinned Node 24 + npm). Cypress is
# pinned + baked at build time (its browser binary is downloaded here) — no
# runtime `npm install -g`. A project that pins its own Cypress still wins via
# `npx`. Browser system libraries (below) are Cypress-specific and kept.

FROM pipeline-node-base:1.0

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
ARG CYPRESS_VERSION=16.1.0
RUN npm install -g "cypress@${CYPRESS_VERSION}"

WORKDIR /app
USER 1000:1000
CMD ["bash"]
