# Scala Plugin — Multi-version build environment using SDKMAN + sbt
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# Java and sbt versions are selected at runtime

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
    && rm -rf /var/lib/apt/lists/*

# ─── Java via SDKMAN ───
ENV SDKMAN_DIR=/opt/sdkman
RUN curl -fsSL "https://get.sdkman.io?rcupdate=false" | bash
RUN bash -c "source ${SDKMAN_DIR}/bin/sdkman-init.sh && \
    sdk install java 17.0.18-tem && \
    sdk install java 21.0.10-tem && \
    sdk default java 21.0.10-tem"
ENV PATH="${SDKMAN_DIR}/candidates/java/current/bin:${SDKMAN_DIR}/bin:${PATH}"

# ─── sbt (Scala Build Tool) ───
RUN bash -c "source ${SDKMAN_DIR}/bin/sdkman-init.sh && \
    sdk install sbt 1.10.7 && \
    sdk install sbt 1.9.9"
ENV PATH="${SDKMAN_DIR}/candidates/sbt/current/bin:${PATH}"

# ─── Scala via Coursier ───
RUN curl -fL https://github.com/coursier/coursier/releases/latest/download/cs-x86_64-pc-linux.gz \
    | gzip -d > /usr/local/bin/cs && chmod +x /usr/local/bin/cs \
    && /usr/local/bin/cs setup --yes --install-dir /usr/local/bin

# Default versions
ENV JAVA_VERSION=21.0.10-tem
ENV SBT_VERSION=1.10.7

# Working directory for pipeline source
WORKDIR /app

# Default entrypoint — overridden by CodeBuildStep commands
CMD ["bash"]
