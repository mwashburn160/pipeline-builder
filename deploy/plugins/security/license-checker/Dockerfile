# License Checker Plugin — OSS License Compliance Scanning
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# Scans project dependencies for license compatibility issues
# Supports Node.js, Python, Java, Go, Ruby, .NET, Rust
#
# Built on pipeline-node-base (one pinned, checksum-verified Node 24 + npm) —
# replaces the NodeSource `setup_24.x | bash` installer (unpinned, and a
# remote script piped into a root shell).

FROM pipeline-node-base:1.0

# Build steps below need root (apt, system pip/gem); the image drops back to
# the unprivileged `plugin` user (uid 1000) at the end.
USER root

RUN apt-retry-install python3 python3-pip ruby ruby-dev

# ─── License scanning tools ───
# Python: pip-licenses
RUN pip3 install --no-cache-dir --break-system-packages pip-licenses==5.5.5

# Go: go-licenses (installed at runtime if needed)
# Ruby: license_finder (pinned — was unpinned)
ARG LICENSE_FINDER_VERSION=7.2.1
RUN gem install license_finder -v "${LICENSE_FINDER_VERSION}" --no-document

# Node.js: license-checker — installed as uid 1000 into the base's
# uid-1000-owned Node prefix. corepack ships with Node 24.
USER 1000:1000
RUN corepack enable && npm install -g license-checker@25.0.1

# ─── Runtime configuration defaults ───
ENV LICENSE_DENY=""

# Working directory for pipeline source
WORKDIR /app
USER 1000:1000

# Default entrypoint — overridden by CodeBuildStep commands
CMD ["bash"]
