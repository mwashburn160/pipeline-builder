# JMeter Plugin — Load and Performance Testing
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# Runs Apache JMeter JMX test plans with configurable thread groups

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
    gnupg \
    && rm -rf /var/lib/apt/lists/*

# ─── Java via SDKMAN ───
ENV SDKMAN_DIR=/opt/sdkman
RUN curl -fsSL "https://get.sdkman.io?rcupdate=false" | bash
RUN bash -c "source ${SDKMAN_DIR}/bin/sdkman-init.sh && \
    sdk install java 21.0.10-tem"
ENV PATH="${SDKMAN_DIR}/candidates/java/current/bin:${SDKMAN_DIR}/bin:${PATH}"

# ─── Apache JMeter ───
ARG JMETER_VERSION=5.6.3
RUN curl -fsSL https://archive.apache.org/dist/jmeter/binaries/apache-jmeter-${JMETER_VERSION}.tgz \
    | tar -xz -C /opt \
    && ln -sf /opt/apache-jmeter-${JMETER_VERSION} /opt/jmeter
ENV PATH="/opt/jmeter/bin:${PATH}"
ENV JMETER_HOME=/opt/jmeter

# ─── Runtime configuration defaults ───
ENV JMETER_TEST_PLAN=""
ENV JMETER_THREADS=10
ENV JMETER_RAMP_UP=10
ENV JMETER_DURATION=60

# Working directory for pipeline source
WORKDIR /app

# Default entrypoint — overridden by CodeBuildStep commands
CMD ["bash"]
