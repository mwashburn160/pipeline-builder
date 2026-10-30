# ShellCheck Plugin — Shell Script Linting
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# Static analysis for bash/sh/zsh scripts
# Detects bugs, syntax issues, and portability problems

# ─── Tool versions (override with --build-arg) ───
ARG SHELLCHECK_VERSION=0.11.0

FROM koalaman/shellcheck:v${SHELLCHECK_VERSION} AS shellcheck-src

FROM plugin-base:26.10

# Build steps below need root (apt, writes under /usr/local, /opt or /etc);
# the image drops back to the unprivileged `plugin` user (uid 1000) at the end.
USER root

ARG SHELLCHECK_VERSION

# ─── ShellCheck (copied from the official image) ───
COPY --from=shellcheck-src /bin/shellcheck /usr/local/bin/shellcheck
RUN chmod 0755 /usr/local/bin/shellcheck

# ─── Runtime configuration defaults ───
ENV SHELLCHECK_VERSION=${SHELLCHECK_VERSION}
ENV SHELLCHECK_SEVERITY=warning
ENV SHELLCHECK_FORMAT=json
ENV SHELLCHECK_SHELL=bash

# Working directory for pipeline source
WORKDIR /app
USER 1000:1000

# Default entrypoint — overridden by CodeBuildStep commands
CMD ["bash"]
