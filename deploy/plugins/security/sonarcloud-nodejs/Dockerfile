# SonarCloud Security Plugin — Node.js scanning
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
#
# Two ingredients, one image:
#   • the Node.js runtime — from pipeline-node-base:1.0 (shared single-version base)
#   • the sonar-scanner CLI — multistage COPY from the upstream sonarsource image
# sonar-scanner analyses source directly (it ships its own bundled JRE); the
# runtime is present so project dependencies resolve/build before the scan.

FROM pipeline-node-base:1.0

# Pinned sonar-scanner CLI from the upstream image (COPY source only). The
# distribution bundles its own JRE, so it runs on any language base.
ARG SONAR_SCANNER_VERSION=12.0
COPY --from=sonarsource/sonar-scanner-cli:${SONAR_SCANNER_VERSION} /opt/sonar-scanner /opt/sonar-scanner
ENV PATH="/opt/sonar-scanner/bin:${PATH}"

WORKDIR /app
CMD ["bash"]
