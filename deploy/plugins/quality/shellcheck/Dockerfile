# ShellCheck Plugin — Shell Script Linting
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# Static analysis for bash/sh/zsh scripts
# Detects bugs, syntax issues, and portability problems

# ─── Tool versions (override with --build-arg) ───
ARG SHELLCHECK_VERSION=0.11.0
ARG SHELLCHECK_PREV_VERSION=0.10.0

FROM koalaman/shellcheck:v${SHELLCHECK_VERSION} AS shellcheck-default
FROM koalaman/shellcheck:v${SHELLCHECK_PREV_VERSION} AS shellcheck-prev

FROM pipeline-plugin-base:24.04

# Build steps below need root (apt, writes under /usr/local, /opt or /etc);
# the image drops back to the unprivileged `plugin` user (uid 1000) at the end.
USER root

ARG SHELLCHECK_VERSION
ARG SHELLCHECK_PREV_VERSION

# ─── ShellCheck — multi-version support (copied from official images) ───
RUN mkdir -p /opt/shellcheck/versions
COPY --from=shellcheck-default /bin/shellcheck /opt/shellcheck/versions/shellcheck-${SHELLCHECK_VERSION}
COPY --from=shellcheck-prev /bin/shellcheck /opt/shellcheck/versions/shellcheck-${SHELLCHECK_PREV_VERSION}
# The active version is a symlink in /opt/shellcheck/bin (first on PATH, owned by the
# plugin user) so the spec's runtime SHELLCHECK_VERSION switch can re-point it without root.
RUN install -d -o 1000 -g 1000 /opt/shellcheck/bin \
    && ln -sf /opt/shellcheck/versions/shellcheck-${SHELLCHECK_VERSION} /opt/shellcheck/bin/shellcheck \
    && chown -h 1000:1000 /opt/shellcheck/bin/shellcheck
ENV PATH="/opt/shellcheck/bin:${PATH}"

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
