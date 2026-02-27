# ShellCheck Plugin — Shell Script Linting
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# Static analysis for bash/sh/zsh scripts
# Detects bugs, syntax issues, and portability problems

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
    xz-utils \
    && rm -rf /var/lib/apt/lists/*

# ─── ShellCheck — multi-version support ───
RUN mkdir -p /opt/shellcheck/versions

RUN curl -fsSL https://github.com/koalaman/shellcheck/releases/download/v0.10.0/shellcheck-v0.10.0.linux.x86_64.tar.xz \
    | tar -xJ -C /opt/shellcheck/versions && mv /opt/shellcheck/versions/shellcheck-v0.10.0/shellcheck /opt/shellcheck/versions/shellcheck-0.10.0

RUN curl -fsSL https://github.com/koalaman/shellcheck/releases/download/v0.9.0/shellcheck-v0.9.0.linux.x86_64.tar.xz \
    | tar -xJ -C /opt/shellcheck/versions && mv /opt/shellcheck/versions/shellcheck-v0.9.0/shellcheck /opt/shellcheck/versions/shellcheck-0.9.0

RUN ln -sf /opt/shellcheck/versions/shellcheck-0.10.0 /usr/local/bin/shellcheck

# ─── Runtime configuration defaults ───
ENV SHELLCHECK_VERSION=0.10.0
ENV SHELLCHECK_SEVERITY=warning
ENV SHELLCHECK_FORMAT=json
ENV SHELLCHECK_SHELL=bash

# Working directory for pipeline source
WORKDIR /app

# Default entrypoint — overridden by CodeBuildStep commands
CMD ["bash"]
