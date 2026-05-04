# SpotBugs Plugin — Java Static Bug Analysis
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder

FROM pipeline-plugin-base:24.04

RUN apt-get update && apt-get install -y --no-install-recommends \
    git zip unzip curl jq ca-certificates build-essential gnupg \
    && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://apt.corretto.aws/corretto.key | gpg --dearmor -o /usr/share/keyrings/corretto-keyring.gpg \
    && echo "deb [signed-by=/usr/share/keyrings/corretto-keyring.gpg] https://apt.corretto.aws stable main" \
    > /etc/apt/sources.list.d/corretto.list

RUN apt-get update && apt-get install -y --no-install-recommends \
    java-17-amazon-corretto-jdk \
    java-21-amazon-corretto-jdk \
    && rm -rf /var/lib/apt/lists/*

ENV SDKMAN_DIR=/opt/sdkman
RUN curl -fsSL "https://get.sdkman.io?rcupdate=false" | bash
RUN bash -c "source ${SDKMAN_DIR}/bin/sdkman-init.sh && \
    sdk install maven 3.9.9 && \
    sdk install gradle 8.12"
ENV PATH="${SDKMAN_DIR}/candidates/maven/current/bin:${SDKMAN_DIR}/candidates/gradle/current/bin:${SDKMAN_DIR}/bin:${PATH}"

# JAVA_HOME must match JAVA_VERSION below — both Corretto 17 and 21 are
# installed for compatibility, but the analyzer runs under JAVA_VERSION's
# JDK by default. Was previously stuck on java-17 with JAVA_VERSION=21,
# producing analyses under the wrong runtime.
ENV JAVA_HOME=/usr/lib/jvm/java-21-amazon-corretto
ENV PATH="${JAVA_HOME}/bin:${PATH}"
ENV JAVA_VERSION=21

WORKDIR /app
CMD ["bash"]
