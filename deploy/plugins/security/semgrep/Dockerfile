# Semgrep Plugin — Open-source SAST Scanner
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# Fast, lightweight static analysis across 30+ languages

FROM pipeline-plugin-base:24.04

RUN apt-retry-install python3 python3-pip python3-venv

# ─── Semgrep CLI ───
# Pinned for reproducible builds — matches the version-pinning policy used
# elsewhere (cfn-lint, checkov, ggshield, twine all pinned).
RUN pip3 install --break-system-packages --no-cache-dir semgrep==1.119.0

# ─── Runtime configuration defaults ───
ENV SEMGREP_RULES=auto
ENV SEMGREP_SEVERITY="ERROR,WARNING"

# Working directory for pipeline source
WORKDIR /app

# Default entrypoint — overridden by CodeBuildStep commands
CMD ["bash"]
