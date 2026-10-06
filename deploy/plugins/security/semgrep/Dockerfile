# Semgrep Plugin — Open-source SAST Scanner
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# Fast, lightweight static analysis across 30+ languages

FROM plugin-base:24.04

# Build steps below need root (apt, writes under /usr/local, /opt or /etc);
# the image drops back to the unprivileged `plugin` user (uid 1000) at the end.
USER root

RUN apt-retry-install python3 python3-pip python3-venv

# ─── Semgrep CLI ───
# Pinned for reproducible builds — matches the version-pinning policy used
# elsewhere (cfn-lint, checkov, ggshield, twine all pinned).
RUN pip3 install --break-system-packages --no-cache-dir semgrep==1.178.0

# ─── CVE remediation inside semgrep's dependency tree ───
# semgrep pulls pyjwt transitively and resolves an older one than the advisory
# requires; nothing in this Dockerfile selects that version, so upgrading it in
# place is the only lever short of dropping semgrep. The same situation as
# azure-cli's bundled pyjwt in acr-push / azure-deploy.
#
# Pinned exactly, like every other version here. The gate is what tells you to
# move it: when a build fails on pyjwt again, bump this pin to the version the
# message names. DELETE this block once semgrep itself requires a patched pyjwt —
# pip keeps the newer of the two, so a stale override would silently pin it BELOW
# what semgrep ships.
ARG SEMGREP_PYJWT_VERSION=2.15.1
RUN set -eux; \
    pip3 install --break-system-packages --no-cache-dir --upgrade "pyjwt==${SEMGREP_PYJWT_VERSION}"; \
    python3 -c "import jwt, sys; sys.exit(0 if jwt.__version__ == '${SEMGREP_PYJWT_VERSION}' else 1)"; \
    semgrep --version >/dev/null

# ─── Runtime configuration defaults ───
ENV SEMGREP_RULES=auto
ENV SEMGREP_SEVERITY="ERROR,WARNING"

# Working directory for pipeline source
WORKDIR /app
USER 1000:1000

# Default entrypoint — overridden by CodeBuildStep commands
CMD ["bash"]
