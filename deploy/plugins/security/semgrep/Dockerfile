# Semgrep Plugin — Open-source SAST Scanner
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# Fast, lightweight static analysis across 30+ languages

FROM plugin-base:26.10

# Build steps below need root (apt, writes under /usr/local, /opt or /etc);
# the image drops back to the unprivileged `plugin` user (uid 1000) at the end.
USER root

RUN apt-retry-install python3 python3-pip python3-venv

# ─── Semgrep CLI ───
# Pinned for reproducible builds — matches the version-pinning policy used
# elsewhere (cfn-lint, checkov, ggshield, twine all pinned).
RUN pip3 install --break-system-packages --no-cache-dir semgrep==1.187.0
# semgrep pins mcp==1.29.0 (used only by `semgrep mcp`), which carries
# GHSA-qx49-fqc8-xw99 (High, fixed in 1.30.0). Raised to the newest 1.x — the
# same major semgrep is built against; 2.x is a new API. Checked by running
# semgrep's MCP server import after the override.
ARG MCP_VERSION=1.30.0
RUN pip3 install --break-system-packages --no-cache-dir "mcp==${MCP_VERSION}" \
    && python3 -c "import importlib.metadata as m; assert m.version('mcp') == '${MCP_VERSION}'" \
    && python3 -c "import semgrep.mcp.server" \
    && semgrep --version

# ─── Runtime configuration defaults ───
ENV SEMGREP_RULES=auto
ENV SEMGREP_SEVERITY="ERROR,WARNING"

# Working directory for pipeline source
WORKDIR /app
USER 1000:1000

# Default entrypoint — overridden by CodeBuildStep commands
CMD ["bash"]
