# Playwright Plugin — Cross-Browser E2E Testing
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# Supports Chromium, Firefox, and WebKit browsers

FROM pipeline-plugin-base:24.04

# ─── Node.js via nvm ───
ENV NVM_DIR=/opt/nvm
RUN mkdir -p ${NVM_DIR} \
    && curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
RUN bash -c "source ${NVM_DIR}/nvm.sh && \
    nvm install 24 && \
    nvm alias default 24 && \
    ln -sfT \"\$(dirname \"\$(dirname \"\$(nvm which 24)\")\")\" ${NVM_DIR}/versions/node/v24"
ENV PATH="${NVM_DIR}/versions/node/v24/bin:${PATH}"

# ─── Playwright browsers + system dependencies ───
# `playwright install --with-deps` shells out to apt-get install for the
# browser system libraries. The base image's apt-cache is built once and
# can become stale within days as Ubuntu rolls security updates that
# supersede the specific `<pkg>=<version>` lines pinned by Playwright's
# bundled deps list.
#
# Step 1 alone (apt-get update against the EC2 regional mirror) isn't
# always enough — the regional mirrors can lag the upstream by hours
# during a security rollout. The mirror's apt index returns version X
# but its package pool has already rolled to X+1, so the install 404s
# on the specific deb. Switch the sources back to the upstream
# archive.ubuntu.com (always authoritative, ~10x slower download speed)
# for the playwright install, then restore the regional mirror at the
# end so any later RUNs in derived images still go fast.
RUN _files="/etc/apt/sources.list.d/ubuntu.sources /etc/apt/sources.list" \
    && for f in $_files; do \
         [ -f "$f" ] && sed -i.regional \
           -e "s|http://[^/]*\.ec2\.archive\.ubuntu\.com/ubuntu|http://archive.ubuntu.com/ubuntu|g" \
           "$f"; \
       done \
    && apt-get update \
    && npx playwright install --with-deps chromium firefox webkit \
    && for f in $_files; do \
         [ -f "$f.regional" ] && mv "$f.regional" "$f"; \
       done \
    && rm -rf /var/lib/apt/lists/*

# Default Node.js version
ENV NODE_VERSION=24

# Working directory for pipeline source
WORKDIR /app

# Default entrypoint — overridden by CodeBuildStep commands
CMD ["bash"]
