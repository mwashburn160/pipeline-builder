# Snyk Security Plugin — Java scanning
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder

FROM public.ecr.aws/docker/library/ubuntu:24.04

# Avoid interactive prompts
ENV DEBIAN_FRONTEND=noninteractive

# System dependencies
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

# ─── Node.js (required by Snyk CLI) ───
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# ─── Java via SDKMAN ───
ENV SDKMAN_DIR=/opt/sdkman
RUN curl -fsSL "https://get.sdkman.io?rcupdate=false" | bash
RUN bash -c "source ${SDKMAN_DIR}/bin/sdkman-init.sh && \
    sdk install java 17.0.18-tem && \
    sdk install java 21.0.10-tem && \
    sdk default java 21.0.10-tem && \
    sdk install maven 3.9.9 && \
    sdk install gradle 8.12"
ENV PATH="${SDKMAN_DIR}/candidates/java/current/bin:${SDKMAN_DIR}/candidates/maven/current/bin:${SDKMAN_DIR}/candidates/gradle/current/bin:${SDKMAN_DIR}/bin:${PATH}"

# ─── Snyk CLI ───
RUN npm install -g snyk

# ─── Runtime configuration defaults ───
ENV SNYK_SEVERITY_THRESHOLD=high
ENV JAVA_VERSION=21.0.10-tem

# Working directory for pipeline source
WORKDIR /app

CMD ["bash"]
