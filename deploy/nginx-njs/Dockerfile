# syntax=docker/dockerfile:1.7
# ----------------------------------------------------------------------------
# Custom nginx image with nginx-module-njs baked in.
#
# Why this exists (F-1.2a): the public `nginxinc/nginx-unprivileged:1.27`
# doesn't ship the njs module. To use the njs scripts under
# `deploy/*/nginx/njs/*.js` (JWT decoding, metrics emission) we either:
#
#   (a) install `nginx-module-njs` at container startup with `apt-get`, which
#       writes to `/var/cache/apt` + `/var/lib/dpkg` and so prevents
#       `ReadonlyRootFilesystem: true`, OR
#   (b) build a custom image with the module preinstalled (this file) and
#       run it under a read-only root.
#
# The k8s plugin / registry / nginx-Fargate hardening pass picked (b);
# this Dockerfile is what the Fargate 04-services.yaml task definition
# pulls instead of `nginx:1.27`, and what the minikube + EC2 nginx pods
# should switch to once the image is published.
#
# Build:
#   ./deploy/nginx-njs/build-image.sh   # builds + tags + pushes to GHCR
#
# The resulting image is pinned by SHA in the consuming manifests so a
# future njs CVE patch is a deliberate version bump rather than a `latest`
# drift.
# ----------------------------------------------------------------------------

FROM nginxinc/nginx-unprivileged:1.27

# Switch to root for the apt install, then drop back to the image's default
# UID 101 so the running container keeps the unprivileged posture.
USER root

# apt cache + dpkg state are wiped after the install so the resulting layer
# doesn't carry them — the runtime container can then run with
# `readOnlyRootFilesystem: true` because no further apt operations happen
# in the running container.
RUN apt-get update -qq \
  && apt-get install -y --no-install-recommends -qq nginx-module-njs \
  && rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*

# Drop privileges. nginxinc/nginx-unprivileged uses UID 101 (nginx) as the
# default — keep that contract intact.
USER 101

# OCI labels for traceability — the consuming manifests pin by SHA, but
# `docker image inspect` shows these when an operator audits the running
# image.
LABEL org.opencontainers.image.source="https://github.com/mwashburn160/pipeline-builder"
LABEL org.opencontainers.image.description="nginx-unprivileged:1.27 with nginx-module-njs baked in (F-1.2a)"
LABEL org.opencontainers.image.licenses="Apache-2.0"
