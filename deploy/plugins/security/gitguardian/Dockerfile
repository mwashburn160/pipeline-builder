# GitGuardian Plugin — Enterprise Secret Detection
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# Scans code for hardcoded credentials, API keys, and sensitive data
# Requires GITGUARDIAN_API_KEY at runtime

FROM pipeline-plugin-base:24.04

RUN apt-retry-install python3 python3-pip

# ─── ggshield (GitGuardian CLI) ───
RUN pip3 install --no-cache-dir --break-system-packages ggshield==1.33.0

# Non-sensitive config only
ENV GG_SCAN_TYPE=path
ENV GG_EXIT_ZERO=false

WORKDIR /app
CMD ["bash"]
