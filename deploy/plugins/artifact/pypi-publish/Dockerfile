# PyPI Publish Plugin — Publish packages to PyPI
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# Publishes Python packages to PyPI or custom repository using twine
# Requires TWINE_USERNAME + TWINE_PASSWORD injected at runtime via CodeBuild secrets

FROM pipeline-plugin-base:24.04

RUN apt-retry-install python3 python3-pip

# ─── Install twine and build ───
RUN pip3 install --no-cache-dir --break-system-packages twine==6.1.0 build==1.2.2

# ─── Runtime configuration defaults ───
# Non-sensitive config only — TWINE_PASSWORD injected at runtime via CodeBuild secrets
ENV PYPI_REPOSITORY=""
ENV TWINE_USERNAME=__token__

# Working directory for pipeline source
WORKDIR /app

# Default entrypoint — overridden by CodeBuildStep commands
CMD ["bash"]
