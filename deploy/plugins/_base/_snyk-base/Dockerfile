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
RUN curl -fsSL https://deb.nodesource.com/setup_24.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/* \
    && corepack enable

# Snyk CLI itself.
RUN npm install -g snyk

# Common runtime defaults (variants may override).
ENV SNYK_SEVERITY_THRESHOLD=high
