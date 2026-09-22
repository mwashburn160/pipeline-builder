# GitHub Status Plugin — Commit Status and Check Runs
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# Posts build results back to pull requests and commits

FROM pipeline-plugin-base:24.04

# Build steps below need root (apt, writes under /usr/local, /opt or /etc);
# the image drops back to the unprivileged `plugin` user (uid 1000) at the end.
USER root

# ─── GitHub CLI (gh) ───
# GitHub CLI keyring pinned by fingerprint — it carries BOTH the original
# signing key (2C61…6059) and its 2026 successor (7F38…3325); fetch-apt-key
# requires the exact set.
RUN fetch-apt-key https://cli.github.com/packages/githubcli-archive-keyring.gpg /usr/share/keyrings/githubcli-archive-keyring.gpg \
       2C6106201985B60E6C7AC87323F3D4EA75716059 7F38BBB59D064DBCB3D84D725612B36462313325 \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
    > /etc/apt/sources.list.d/github-cli.list \
    && apt-retry-install gh

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
USER 1000:1000

# Default entrypoint — overridden by CodeBuildStep commands
CMD ["bash"]
