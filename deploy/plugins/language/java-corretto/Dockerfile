# Java/Kotlin Corretto Plugin — AWS Amazon Corretto JDK
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# Optimized for AWS workloads with long-term support
# Java version is selected at runtime via JAVA_VERSION env var
# Kotlin compiler pre-installed for Kotlin projects (JVM target)

FROM public.ecr.aws/docker/library/ubuntu:24.04

# Avoid interactive prompts
ENV DEBIAN_FRONTEND=noninteractive

# System dependencies for builds
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    zip \
    unzip \
    curl \
    jq \
    ca-certificates \
    build-essential \
    gnupg \
    && rm -rf /var/lib/apt/lists/*

# Install Amazon Corretto repository
RUN curl -fsSL https://apt.corretto.aws/corretto.key | gpg --dearmor -o /usr/share/keyrings/corretto-keyring.gpg \
    && echo "deb [signed-by=/usr/share/keyrings/corretto-keyring.gpg] https://apt.corretto.aws stable main" \
    > /etc/apt/sources.list.d/corretto.list

# Pre-install common Corretto versions
RUN apt-get update && apt-get install -y --no-install-recommends \
    java-11-amazon-corretto-jdk \
    java-17-amazon-corretto-jdk \
    java-21-amazon-corretto-jdk \
    && rm -rf /var/lib/apt/lists/*

# Install Maven, Gradle, and Kotlin via SDKMAN
ENV SDKMAN_DIR=/opt/sdkman
RUN curl -fsSL "https://get.sdkman.io?rcupdate=false" | bash
RUN bash -c "source ${SDKMAN_DIR}/bin/sdkman-init.sh && \
    sdk install maven 3.9.9 && \
    sdk install gradle 8.12 && \
    sdk install kotlin 2.1.0 && \
    sdk install kotlin 1.9.25 && \
    sdk default kotlin 2.1.0"
ENV PATH="${SDKMAN_DIR}/candidates/maven/current/bin:${SDKMAN_DIR}/candidates/gradle/current/bin:${SDKMAN_DIR}/candidates/kotlin/current/bin:${SDKMAN_DIR}/bin:${PATH}"

# Default to Corretto 17
ENV JAVA_HOME=/usr/lib/jvm/java-17-amazon-corretto
ENV PATH="${JAVA_HOME}/bin:${PATH}"

# Default Java version (overridden by JAVA_VERSION env var at runtime)
ENV JAVA_VERSION=17

# Default Kotlin version (overridden by KOTLIN_VERSION env var at runtime)
ENV KOTLIN_VERSION=2.1.0

# Build tool selection (auto = detect from project files)
ENV BUILD_TOOL=auto

# Working directory for pipeline source
WORKDIR /app

# Default entrypoint — overridden by CodeBuildStep commands
CMD ["bash"]
