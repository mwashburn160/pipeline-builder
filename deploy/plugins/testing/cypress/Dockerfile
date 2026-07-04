# Cypress Plugin — End-to-End Browser Testing
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# Runs Cypress E2E tests with video recording and screenshot capture
#
# Thin layer over pipeline-node-base (one pinned Node 24 + npm). Cypress is
# pinned + baked at build time (its browser binary is downloaded here) — no
# runtime `npm install -g`. A project that pins its own Cypress still wins via
# `npx`. Browser system libraries (below) are Cypress-specific and kept.

FROM pipeline-node-base:1.0

# Cypress browser prerequisites (system libs for the bundled Electron/Chromium).
RUN apt-retry-install libgtk2.0-0 libgtk-3-0 libgbm-dev libnotify-dev libnss3 libxss1 libasound2t64 libxtst6 xauth xvfb fonts-liberation

# TODO(confirm): pin the intended Cypress version at build time.
ARG CYPRESS_VERSION=13.17.0
RUN npm install -g "cypress@${CYPRESS_VERSION}"

WORKDIR /app
CMD ["bash"]
