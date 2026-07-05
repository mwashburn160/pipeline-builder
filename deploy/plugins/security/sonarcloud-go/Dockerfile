# SonarCloud Security Plugin — Go scanning
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
#
# Two ingredients, one image:
#   • the Go runtime — from pipeline-go-base:1.0 (shared single-version base)
#   • the sonar-scanner CLI — multistage COPY from the upstream sonarsource image
# sonar-scanner analyses source directly (it ships its own bundled JRE); the
# runtime is present so project dependencies resolve/build before the scan.

# Global ARG (before the first FROM) so it parameterizes the sonar-scanner
# stage's image tag. An ARG isn't interpolated inside `COPY --from=<image>:${ARG}`
# (BuildKit sees an empty tag → "invalid reference format"), so the scanner is
# pulled via a named stage instead — same pattern as _base/_ruby-base.
ARG SONAR_SCANNER_VERSION=12.0
FROM sonarsource/sonar-scanner-cli:${SONAR_SCANNER_VERSION} AS sonar-scanner

FROM pipeline-go-base:1.0

# Pinned sonar-scanner CLI from the upstream image (COPY source only). The
# distribution bundles its own JRE, so it runs on any language base.
COPY --from=sonar-scanner /opt/sonar-scanner /opt/sonar-scanner
ENV PATH="/opt/sonar-scanner/bin:${PATH}"

WORKDIR /app
CMD ["bash"]
