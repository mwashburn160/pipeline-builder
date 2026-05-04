# Pipeline Builder — Snyk Family Base Image
#
# Built tag: pipeline-snyk-base:1.0
#
# Used as the FROM by all 7 snyk-{nodejs,python,go,java,dotnet,ruby,rust}
# plugins. Centralizes the ~30 lines of Node.js + corepack + snyk CLI
# installation that previously lived in every variant.
#
# Each variant adds only its language toolchain (goenv/pyenv/SDKMAN/etc.)
# in ~10 lines.

FROM pipeline-plugin-base:24.04

# Snyk's CLI is JavaScript — needs Node + npm. corepack ships with
# NodeSource's nodejs and provides the npm/pnpm/yarn shims at /usr/local/bin
# without conflicting with Ubuntu's `npm` deb (which would shadow nodejs).
# Retries on apt mirror flaps. CRITICAL: do NOT use --fix-missing here.
# That flag tells apt to silently install whatever it CAN fetch; if
# NodeSource's mirror is flaky and apt falls back to Ubuntu's nodejs
# (currently 18.19, no corepack) the build "succeeds" but corepack enable
# below fails. We want a clean retry of the full NodeSource install, not
# a silent downgrade to a different package source.
RUN set -eux; \
    for i in 1 2 3 4 5; do \
      curl -fsSL https://deb.nodesource.com/setup_24.x | bash - && break \
        || { echo "NodeSource setup attempt $i failed; sleeping $((i * 10))s"; sleep $((i * 10)); }; \
    done; \
    for i in 1 2 3 4 5; do \
      apt-get install -y --no-install-recommends nodejs && break \
        || { echo "apt install nodejs attempt $i failed; sleeping $((i * 10))s"; sleep $((i * 10)); }; \
    done; \
    # Verify we got NodeSource's nodejs (24.x), not Ubuntu's old fallback.
    NODE_MAJOR=$(node --version | sed 's/^v//;s/\..*//'); \
    [ "$NODE_MAJOR" -ge 24 ] || { echo "ERROR: nodejs $NODE_MAJOR installed (expected 24+); NodeSource source likely not active"; exit 1; }; \
    rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*.deb; \
    corepack enable

# Snyk CLI itself.
RUN npm install -g snyk

# Common runtime defaults (variants may override).
ENV SNYK_SEVERITY_THRESHOLD=high
