# GitGuardian Plugin — Enterprise Secret Detection
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# Scans code for hardcoded credentials, API keys, and sensitive data
# Requires GITGUARDIAN_API_KEY at runtime

FROM public.ecr.aws/docker/library/ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
    git zip unzip curl jq ca-certificates python3 python3-pip \
    && rm -rf /var/lib/apt/lists/*

# ─── ggshield (GitGuardian CLI) ───
RUN pip3 install --no-cache-dir --break-system-packages ggshield==1.33.0

# Non-sensitive config only
ENV GG_SCAN_TYPE=path
ENV GG_EXIT_ZERO=false

WORKDIR /app
CMD ["bash"]
