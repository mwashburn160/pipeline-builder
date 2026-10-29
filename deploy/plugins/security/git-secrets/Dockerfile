# Git Secrets Plugin — Secret/Credential Detection
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# Combines Gitleaks + TruffleHog for comprehensive secret scanning
# Detects API keys, passwords, tokens, and other sensitive data in code

# ─── Tool versions (override with --build-arg) ───
ARG GITLEAKS_VERSION=8.30.1
# Gitleaks 8.30.1 also carries the fix for CVE-2026-63728 (Sprig template
# injection, CVSS 8.1), whose advisory has no earlier `fixed` event.
ARG TRUFFLEHOG_VERSION=3.99.7

FROM zricethezav/gitleaks:v${GITLEAKS_VERSION} AS gitleaks-src
FROM trufflesecurity/trufflehog:${TRUFFLEHOG_VERSION} AS trufflehog-src

FROM plugin-base:24.04

# Build steps below need root (apt, writes under /usr/local, /opt or /etc);
# the image drops back to the unprivileged `plugin` user (uid 1000) at the end.
USER root

ARG GITLEAKS_VERSION
ARG TRUFFLEHOG_VERSION

# ─── Gitleaks — secret detection (copied from official image) ───
COPY --from=gitleaks-src /usr/bin/gitleaks /usr/local/bin/gitleaks
RUN chmod 0755 /usr/local/bin/gitleaks

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
