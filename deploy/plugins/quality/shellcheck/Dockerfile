# ShellCheck Plugin — Shell Script Linting
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# Static analysis for bash/sh/zsh scripts
# Detects bugs, syntax issues, and portability problems

# ─── Tool versions (override with --build-arg) ───
ARG SHELLCHECK_VERSION=0.10.0
ARG SHELLCHECK_PREV_VERSION=0.9.0

FROM koalaman/shellcheck:v${SHELLCHECK_VERSION} AS shellcheck-default
FROM koalaman/shellcheck:v${SHELLCHECK_PREV_VERSION} AS shellcheck-prev

FROM pipeline-plugin-base:24.04

ARG SHELLCHECK_VERSION
ARG SHELLCHECK_PREV_VERSION

# ─── ShellCheck — multi-version support (copied from official images) ───
RUN mkdir -p /opt/shellcheck/versions
COPY --from=shellcheck-default /bin/shellcheck /opt/shellcheck/versions/shellcheck-${SHELLCHECK_VERSION}
COPY --from=shellcheck-prev /bin/shellcheck /opt/shellcheck/versions/shellcheck-${SHELLCHECK_PREV_VERSION}
RUN ln -sf /opt/shellcheck/versions/shellcheck-${SHELLCHECK_VERSION} /usr/local/bin/shellcheck

# ─── Runtime configuration defaults ───
ENV SHELLCHECK_VERSION=${SHELLCHECK_VERSION}
ENV SHELLCHECK_SEVERITY=warning
ENV SHELLCHECK_FORMAT=json
ENV SHELLCHECK_SHELL=bash

# Working directory for pipeline source
WORKDIR /app

# Default entrypoint — overridden by CodeBuildStep commands
CMD ["bash"]
