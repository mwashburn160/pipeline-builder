# Pipeline Builder — Trivy Family Base Image
#
# Built tag: plugin-trivy-base:1.0
#
# Used as the FROM by the single language-agnostic `trivy` plugin.
# `trivy fs`/`trivy config` scan lockfiles and IaC/config statically, so no
# language runtime is layered on top — the plugin's Dockerfile is just
# `FROM plugin-trivy-base:1.0` + WORKDIR/CMD.
# ONE pinned trivy. It bundled two for runtime selection until the image and the
# plugin spec drifted onto different versions and the switch failed closed.
#
# VULN SCAN (OSV, 2026-09-27): GO-2026-4919 / CVE-2026-33634 matches both pins and is a
# FALSE POSITIVE for them. It records ONE malicious release — a threat actor published a
# compromised trivy v0.69.4 on 2026-03-19 — but its affected range is `introduced: 0.69.4`
# with NO `fixed` event, so OSV's semver matcher flags every later version too. The pin
# below is a legitimate release well after it, so bumping cannot clear the match. If a
# future scan flags this: check whether the advisory has gained a `fixed` event before
# treating it as actionable.
#
# The real exposure in that threat class is a re-pushed TAG, not a version number. This
# FROM resolves by tag, like every other external base in deploy/plugins (ruby, ubuntu)
# — worth pinning the whole family by digest, which is a change to all of them rather than
# to this file alone.

ARG TRIVY_VERSION=0.76.1

FROM aquasec/trivy:${TRIVY_VERSION} AS trivy-src

FROM plugin-base:26.10
ARG TRIVY_VERSION

# ONE trivy, installed straight onto PATH. This used to bake two versions into
# /opt/trivy/versions with a symlink the plugin re-pointed at runtime, which is
# what let the image and the plugin spec drift apart: the spec asked for a
# version the image no longer carried, and the switch failed CLOSED with
# "not in this image" — a broken plugin that only showed up at run time.
USER root
COPY --from=trivy-src /usr/local/bin/trivy /usr/local/bin/trivy
RUN chmod 0755 /usr/local/bin/trivy

ENV TRIVY_VERSION=${TRIVY_VERSION}
ENV TRIVY_SEVERITY=HIGH,CRITICAL
ENV TRIVY_FORMAT=json

WORKDIR /app
USER 1000:1000
CMD ["bash"]
