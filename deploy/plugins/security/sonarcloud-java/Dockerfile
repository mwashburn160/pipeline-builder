# SonarCloud Security Plugin — Java/Kotlin scanning
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
#
# Inherits from the sonarcloud family base image (pipeline-sonarcloud-base:1.0)
# which provides sonarcloud CLI + (where applicable) Node.js. This file
# only adds the Java/Kotlin toolchain.

FROM pipeline-sonarcloud-base:1.0

# ─── Java via SDKMAN ───
ENV SDKMAN_DIR=/opt/sdkman
RUN curl -fsSL https://get.sdkman.io | bash
RUN bash -c "source ${SDKMAN_DIR}/bin/sdkman-init.sh && \
    sdk install java 21.0.10-tem && \
    sdk default java 21.0.10-tem"
ENV PATH="${SDKMAN_DIR}/candidates/java/current/bin:${PATH}"
ENV JAVA_HOME="${SDKMAN_DIR}/candidates/java/current"
ENV JAVA_VERSION=21.0.10-tem

WORKDIR /app
CMD ["bash"]
