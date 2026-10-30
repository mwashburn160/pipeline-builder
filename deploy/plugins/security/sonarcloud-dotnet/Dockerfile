# SonarCloud Security Plugin — .NET scanning
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
#
# Two ingredients, one image:
#   • the .NET runtime — from plugin-dotnet-base:1.0 (shared single-version base)
#   • the sonar-scanner CLI — multistage COPY from the upstream sonarsource image
# sonar-scanner analyses source directly (on the scanner image's own JRE); the
# runtime is present so project dependencies restore/build before the scan.

# Global ARG (before the first FROM) so it parameterizes the sonar-scanner
# stage's image tag. An ARG isn't interpolated inside `COPY --from=<image>:${ARG}`
# (BuildKit sees an empty tag → "invalid reference format"), so the scanner is
# pulled via a named stage instead — same pattern as _base/_ruby-base.
ARG SONAR_SCANNER_VERSION=12.3
FROM sonarsource/sonar-scanner-cli:${SONAR_SCANNER_VERSION} AS sonar-scanner

FROM plugin-dotnet-base:1.0

# ─── amd64-only guard ───
# sonarsource/sonar-scanner-cli publishes a linux/amd64 manifest ONLY (checked
# for 12.1, 12.2 and 12.3). The COPY below takes that image's Amazon Corretto
# JRE, so on arm64 the build either fails on the missing manifest or — worse —
# succeeds while baking in an x86-64 ELF JRE that dies with "exec format error"
# the first time a pipeline runs the scan. Fail here with a readable reason
# instead of shipping an image that is broken only at runtime.
ARG SONAR_SCANNER_VERSION
RUN set -eux; \
    case "$(dpkg --print-architecture)" in \
      amd64) ;; \
      *) echo "sonar-scanner-cli ${SONAR_SCANNER_VERSION}: upstream publishes linux/amd64 only; this plugin cannot be built for $(dpkg --print-architecture)" >&2; exit 1 ;; \
    esac

# Pinned sonar-scanner CLI from the upstream image (COPY source only). The
# 12.x image does NOT bundle a JRE inside /opt/sonar-scanner — it runs on the
# image's system Corretto 21 — so that JDK is copied alongside and JAVA_HOME
# points the launcher at it (this base has no Java of its own; without it
# `sonar-scanner` dies with "Could not find 'java' executable").
COPY --from=sonar-scanner /opt/sonar-scanner /opt/sonar-scanner
COPY --from=sonar-scanner /usr/lib/jvm/java-21-amazon-corretto /opt/sonar-scanner/jre
ENV JAVA_HOME=/opt/sonar-scanner/jre
ENV PATH="/opt/sonar-scanner/bin:${PATH}"

WORKDIR /app
USER 1000:1000
CMD ["bash"]
