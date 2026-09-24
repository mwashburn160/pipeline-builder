# Git Secrets Plugin — Secret/Credential Detection
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# Combines Gitleaks + TruffleHog for comprehensive secret scanning
# Detects API keys, passwords, tokens, and other sensitive data in code

# ─── Tool versions (override with --build-arg) ───
ARG GITLEAKS_VERSION=8.30.1
ARG GITLEAKS_PREV_VERSION=8.29.1
ARG TRUFFLEHOG_VERSION=3.97.8

FROM zricethezav/gitleaks:v${GITLEAKS_VERSION} AS gitleaks-default
FROM zricethezav/gitleaks:v${GITLEAKS_PREV_VERSION} AS gitleaks-prev
FROM trufflesecurity/trufflehog:${TRUFFLEHOG_VERSION} AS trufflehog-src

FROM pipeline-plugin-base:24.04

# Build steps below need root (apt, writes under /usr/local, /opt or /etc);
# the image drops back to the unprivileged `plugin` user (uid 1000) at the end.
USER root

ARG GITLEAKS_VERSION
ARG GITLEAKS_PREV_VERSION
ARG TRUFFLEHOG_VERSION

# ─── Gitleaks — secret detection (copied from official image) ───
RUN mkdir -p /opt/gitleaks/versions
COPY --from=gitleaks-default /usr/bin/gitleaks /opt/gitleaks/versions/gitleaks-${GITLEAKS_VERSION}
COPY --from=gitleaks-prev /usr/bin/gitleaks /opt/gitleaks/versions/gitleaks-${GITLEAKS_PREV_VERSION}
# The active version is a symlink in /opt/gitleaks/bin (first on PATH, owned by the
# plugin user) so the spec's runtime GITLEAKS_VERSION switch can re-point it without root.
RUN install -d -o 1000 -g 1000 /opt/gitleaks/bin \
    && ln -sf /opt/gitleaks/versions/gitleaks-${GITLEAKS_VERSION} /opt/gitleaks/bin/gitleaks \
    && chown -h 1000:1000 /opt/gitleaks/bin/gitleaks
ENV PATH="/opt/gitleaks/bin:${PATH}"

# ─── TruffleHog — credential scanner (copied from official image) ───
RUN mkdir -p /opt/trufflehog/versions
COPY --from=trufflehog-src /usr/bin/trufflehog /opt/trufflehog/versions/trufflehog-${TRUFFLEHOG_VERSION}
RUN ln -sf /opt/trufflehog/versions/trufflehog-${TRUFFLEHOG_VERSION} /usr/local/bin/trufflehog

# ─── Runtime configuration defaults ───
ENV GITLEAKS_VERSION=${GITLEAKS_VERSION}
ENV SCAN_MODE=directory
ENV GITLEAKS_CONFIG=""
ENV REPORT_FORMAT=json

# Working directory for pipeline source
WORKDIR /app
USER 1000:1000

# Default entrypoint — overridden by CodeBuildStep commands
CMD ["bash"]
