# Base image pinned BY DIGEST (tag kept for readers): a re-pushed or
# compromised tag cannot change what a release image is built from. Bump both
# together (docker buildx imagetools inspect node:<ver>-alpine).
ARG NODE_IMAGE=node:24.21.0-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1

# Production stage
# F-0.3: node_modules is built OUTSIDE Docker by the docker:build script
# (`pnpm deploy --filter <name> --prod --legacy .docker-build`) so the
# install runs against pnpm-lock.yaml. The .docker-build/ tree carries a
# lockfile-locked, prod-only dep set; this stage just copies it in.
# Closes the caret-range drift trap that bit jest in May 2026: a Docker
# rebuild can no longer pull a newer caret-compatible version of any
# dep behind the platform's back.
FROM ${NODE_IMAGE}
# Runtime hardening: pull the latest patched OS packages (the base digest can lag
# an openssl/musl/zlib fix) and drop the npm/corepack/yarn CLIs the image never runs —
# they ship their own dependency trees (tar, pacote, sigstore, minimatch …) that the
# release grype gate would otherwise flag.
RUN apk upgrade --no-cache \
    && apk add --no-cache curl \
    && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
       /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
       /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-*

# Chromium, for stakeholder-report PDFs (services/report-pdf.ts).
#
# THE DISTRO PACKAGE, not puppeteer's bundled Chrome. Puppeteer downloads a glibc build
# that cannot run on musl at all, so alpine's own package is not a size optimisation — it
# is the only thing that works here. It also means Chromium gets its security updates from
# `apk upgrade` on every rebuild, like every other OS package in this image, instead of
# being pinned to whatever puppeteer's release happened to bundle.
#
# The font packages are not optional. Without them Chromium renders every glyph as a box,
# and the failure is invisible to any test that only checks the PDF was produced —
# `ttf-freefont` covers Latin, `font-noto-cjk` and `font-noto-emoji` cover a pipeline or
# project name that is not in Latin script, which is a normal thing for an org to have.
#
# `CHROMIUM_FLAGS` is deliberately NOT set: the flags live in report-pdf.ts's
# `chromiumArgs()` so the code and the container cannot disagree about them.
RUN apk add --no-cache \
      chromium \
      ttf-freefont \
      font-noto-cjk \
      font-noto-emoji \
    && rm -rf /var/cache/apk/*
ENV REPORT_PDF_CHROMIUM_PATH=/usr/bin/chromium-browser

# Chromium's scratch space. The container root filesystem is read-only in every k8s
# deploy, so the deploys mount an emptyDir here; this creates it (and makes it writable by
# uid 1000) so a plain `docker run` works too. Chromium exits at startup if it cannot write
# its user-data dir, so getting this wrong does not degrade — PDFs simply never render.
RUN mkdir -p /tmp/report-pdf && chown node:node /tmp/report-pdf

WORKDIR /app
COPY --chown=node:node .docker-build/node_modules ./node_modules
COPY --chown=node:node .docker-build/package.json .
COPY --chown=node:node .docker-build/lib/ /app

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:3000/health || exit 1

USER node
CMD ["node", "--import", "@pipeline-builder/api-server/lib/otel-bootstrap.js", "index.js"]