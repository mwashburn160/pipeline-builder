# License Checker Plugin — OSS License Compliance Scanning
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# Scans project dependencies for license compatibility issues
# Supports Node.js, Python, Java, Go, Ruby, .NET, Rust
#
# Built on plugin-node-base (one pinned, checksum-verified Node 26 + npm) —
# replaces the NodeSource `setup_24.x | bash` installer (unpinned, and a
# remote script piped into a root shell).

FROM plugin-node-base:1.0

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
# uid-1000-owned Node prefix. corepack comes from plugin-node-base (Node 26 no longer bundles it).
USER 1000:1000
# read-installed (a license-checker dependency) ships its own test fixtures,
# including test/fixtures/extraneous-detected and extraneous-dev-dep — two
# package.json files (version 0.0.0) whose names were later registered on npm
# as malware (GHSA-46x4-f3w7-wfvg, GHSA-65f2-f2qh-xmjq), so every scan reported
# "malware" in this plugin. Nothing malicious is installed; the fixtures are
# never loaded at runtime. Delete the test directory and fail the build if any
# fixture manifest survives, so a dependency move cannot quietly bring it back.
RUN set -eux; \
    corepack enable; \
    npm install -g license-checker@25.0.1; \
    root="$(npm root -g)"; \
    find "$root" -type d -path '*/read-installed/test' -prune -exec rm -rf {} +; \
    if find "$root" -path '*/extraneous-detected/package.json' -o -path '*/extraneous-dev-dep/package.json' | grep -q .; then \
      echo "read-installed test fixtures still present" >&2; exit 1; \
    fi; \
    command -v license-checker; \
    # `license-checker --version` prints the version but exits 1, so read it from the package.
    test "$(node -p "require('$root/license-checker/package.json').version")" = 25.0.1

# ─── Runtime configuration defaults ───
ENV LICENSE_DENY=""

# Working directory for pipeline source
WORKDIR /app
USER 1000:1000

# Default entrypoint — overridden by CodeBuildStep commands
CMD ["bash"]
