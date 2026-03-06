# Grype Plugin — Anchore Vulnerability Scanner
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# Scans container images, filesystems, and SBOMs for known CVEs

FROM anchore/grype:latest AS grype-bin
FROM anchore/syft:latest AS syft-bin

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
    && rm -rf /var/lib/apt/lists/*

# ─── Grype and Syft binaries ───
COPY --from=grype-bin /grype /usr/local/bin/grype
COPY --from=syft-bin /syft /usr/local/bin/syft

# ─── Runtime configuration defaults ───
ENV GRYPE_SEVERITY=high
ENV GRYPE_SCOPE="dir:."
ENV GRYPE_FORMAT=json
ENV GRYPE_FAIL_ON=high

# Working directory for pipeline source
WORKDIR /app

# Default entrypoint — overridden by CodeBuildStep commands
CMD ["bash"]
