# GitGuardian Plugin — Enterprise Secret Detection
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# Scans code for hardcoded credentials, API keys, and sensitive data
# Requires GITGUARDIAN_API_KEY at runtime

FROM pipeline-plugin-base:24.04

# Build steps below need root (apt, writes under /usr/local, /opt or /etc);
# the image drops back to the unprivileged `plugin` user (uid 1000) at the end.
USER root

RUN apt-retry-install python3 python3-pip

# ─── ggshield (GitGuardian CLI) ───
RUN pip3 install --no-cache-dir --break-system-packages ggshield==1.54.0

# Non-sensitive config only
ENV GG_SCAN_TYPE=path
ENV GG_EXIT_ZERO=false

WORKDIR /app
USER 1000:1000
CMD ["bash"]
