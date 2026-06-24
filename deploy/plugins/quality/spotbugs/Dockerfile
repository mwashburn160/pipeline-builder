# SpotBugs Plugin — Java Static Bug Analysis
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder

FROM pipeline-plugin-base:24.04

RUN apt-retry-install build-essential

RUN curl -fsSL https://apt.corretto.aws/corretto.key | gpg --dearmor -o /usr/share/keyrings/corretto-keyring.gpg \
    && echo "deb [signed-by=/usr/share/keyrings/corretto-keyring.gpg] https://apt.corretto.aws stable main" \
    > /etc/apt/sources.list.d/corretto.list

RUN apt-retry-install java-25-amazon-corretto-jdk

ENV SDKMAN_DIR=/opt/sdkman
RUN curl -fsSL "https://get.sdkman.io?rcupdate=false" | bash
RUN bash -c "source ${SDKMAN_DIR}/bin/sdkman-init.sh && \
    sdk install maven 3.9.9 && \
    sdk install gradle 9.6.0"
ENV PATH="${SDKMAN_DIR}/candidates/maven/current/bin:${SDKMAN_DIR}/candidates/gradle/current/bin:${SDKMAN_DIR}/bin:${PATH}"

# JAVA_HOME must match JAVA_VERSION below. Per the non-language plugin
# policy only the latest Corretto (25) is installed; the analyzer runs under it.
ENV JAVA_HOME=/usr/lib/jvm/java-25-amazon-corretto
ENV PATH="${JAVA_HOME}/bin:${PATH}"
ENV JAVA_VERSION=25

WORKDIR /app
CMD ["bash"]
