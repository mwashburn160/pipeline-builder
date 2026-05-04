# GitHub Status Plugin — Commit Status and Check Runs
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# Posts build results back to pull requests and commits

FROM pipeline-plugin-base:24.04

# ─── GitHub CLI (gh) ───
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
    > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/*

# ─── Runtime configuration defaults ───
ENV GITHUB_OWNER=""
ENV GITHUB_REPO=""
ENV GITHUB_SHA=""
ENV STATUS_STATE=success
ENV STATUS_CONTEXT=pipeline
ENV STATUS_DESCRIPTION=""
ENV STATUS_TARGET_URL=""

# Working directory for pipeline source
WORKDIR /app

# Default entrypoint — overridden by CodeBuildStep commands
CMD ["bash"]
