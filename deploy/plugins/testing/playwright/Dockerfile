# Playwright Plugin — Cross-Browser E2E Testing
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# Supports Chromium, Firefox, and WebKit browsers
#
# Thin layer over pipeline-node-base (one pinned Node 24 + npm). Playwright
# (@playwright/test) is pinned + baked at build time — no runtime
# `npm install -g`. A project that pins its own Playwright still wins via
# `npx`. The browsers + their system libraries are installed below.

FROM pipeline-node-base:1.0

# TODO(confirm): pin the intended Playwright version at build time.
ARG PLAYWRIGHT_VERSION=1.49.0
RUN npm install -g "@playwright/test@${PLAYWRIGHT_VERSION}"

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
    && playwright install --with-deps chromium firefox webkit \
    && for f in $_files; do \
         [ -f "$f.regional" ] && mv "$f.regional" "$f"; \
       done \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
CMD ["bash"]
