# Azure Deploy Plugin — Azure Infrastructure Deployment
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# Supports Web App, Container Instances, AKS, and Function deployments
# Includes Azure CLI and kubectl for infrastructure management

ARG KUBECTL_VERSION=1.37.3

# kubectl is built from source (stage below), not fetched from dl.k8s.io.
# WHY (2026-11-25): the v1.37.3 release binary (the newest stable) links
# golang.org/x/net v0.57.0 — GO-2026-6612 (Critical) and GO-2026-6603, -6610,
# -6611, -6617 (High), all fixed in v0.60.0 — and no kubectl release links a
# fixed x/net yet. Same route as cloudformation's rain: build the tagged source
# on the shared Go builder image with x/net raised, then assert the raise took.
# Source integrity: the tag must resolve to KUBECTL_COMMIT, or the build fails.
# Version stamping mirrors hack/lib/version.sh, so `kubectl version --client`
# still reports v${KUBECTL_VERSION}. Return to the release binary (fetch-verified
# against dl.k8s.io's kubectl.sha256) once one links x/net >= v0.60.0.
ARG KUBECTL_COMMIT=f81a9c5f95912fd97b7c8aa4966301aeae84a253
ARG KUBECTL_XNET_VERSION=0.63.0
# Same pinned toolchain as api/plugin's tools stage (toolchain-drift-contract).
ARG GO_IMAGE=golang:1.27.4-alpine@sha256:70bd7ddea8b6cbe5d6943cde279d6b67feb10cc924fb9100d1d8757c1575b280

FROM ${GO_IMAGE} AS kubectl-build
ARG KUBECTL_VERSION
ARG KUBECTL_COMMIT
ARG KUBECTL_XNET_VERSION
ENV CGO_ENABLED=0 GOTOOLCHAIN=local
RUN apk add --no-cache git
# Clone retried (github.com flaps); the commit check is outside the retry — a
# tag that resolves to the wrong commit is not transient.
RUN set -eux; \
    for attempt in 1 2 3 4 5; do \
      rm -rf /src/kubernetes; \
      if git clone --depth 1 --branch "v${KUBECTL_VERSION}" https://github.com/kubernetes/kubernetes.git /src/kubernetes; then break; fi; \
      echo "kubernetes clone failed (attempt $attempt/5); retrying" >&2; \
      sleep $((attempt * 5)); \
    done; \
    test -d /src/kubernetes/.git; \
    got="$(git -C /src/kubernetes rev-parse HEAD)"; \
    [ "$got" = "${KUBECTL_COMMIT}" ] || { echo "kubernetes v${KUBECTL_VERSION} resolved to $got, expected ${KUBECTL_COMMIT}" >&2; exit 1; }
WORKDIR /src/kubernetes
# vendor/ is dropped so the raised x/net (and whatever MVS lifts with it) is
# resolved from the module proxy, checksum-verified against sum.golang.org.
RUN set -eux; \
    rm -rf vendor; \
    for attempt in 1 2 3 4 5; do \
      go get "golang.org/x/net@v${KUBECTL_XNET_VERSION}" \
        && go list -deps ./cmd/kubectl > /dev/null && break; \
      echo "go get/list failed (attempt $attempt/5)" >&2; sleep $((attempt * 5)); \
    done; \
    ld="-s -w"; \
    for pkg in k8s.io/client-go/pkg/version k8s.io/component-base/version; do \
      ld="$ld -X $pkg.gitVersion=v${KUBECTL_VERSION} -X $pkg.gitCommit=${KUBECTL_COMMIT} -X $pkg.gitTreeState=clean"; \
      ld="$ld -X $pkg.gitMajor=${KUBECTL_VERSION%%.*} -X $pkg.gitMinor=$(echo "${KUBECTL_VERSION}" | cut -d. -f2)"; \
      ld="$ld -X $pkg.buildDate=1970-01-01T00:00:00Z"; \
    done; \
    go build -trimpath -buildvcs=false -ldflags "$ld" -o /out/kubectl ./cmd/kubectl; \
    /out/kubectl version --client
# Fail the BUILD if the raise did not take (asserted as >= the pin: MVS may
# resolve higher than asked).
RUN set -eux; \
    _want="v${KUBECTL_XNET_VERSION}"; \
    _got="$(go version -m /out/kubectl | awk '$1 == "dep" && $2 == "golang.org/x/net" { print $3 }')"; \
    [ -n "$_got" ] || { echo "golang.org/x/net is not linked into kubectl" >&2; exit 1; }; \
    [ "$(printf '%s\n%s\n' "$_want" "$_got" | sort -V | head -1)" = "$_want" ] \
      || { echo "golang.org/x/net is $_got, expected >= $_want" >&2; exit 1; }; \
    echo "ok: golang.org/x/net $_got"

FROM plugin-base:26.10

# Build steps below need root (apt, writes under /usr/local, /opt or /etc);
# the image drops back to the unprivileged `plugin` user (uid 1000) at the end.
USER root

RUN apt-retry-install apt-transport-https lsb-release

# ─── Azure CLI ───
# Microsoft release-signing key pinned by fingerprint.
# Microsoft publishes the azure-cli apt repo per Ubuntu release and has none
# for 26.10 ("stonking": no Release file), so `lsb_release -cs` broke the
# build. Pinned to the newest one it serves (resolute, Ubuntu 26.04 — matching
# artifact/acr-push); azure-cli bundles its own Python under /opt/az, so the
# package does not depend on the OS Python.
ARG AZURE_CLI_DIST=resolute
RUN fetch-apt-key https://packages.microsoft.com/keys/microsoft.asc /usr/share/keyrings/microsoft.gpg \
       BC528686B50D79E339D3721CEB3E94ADBE1229CF \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/microsoft.gpg] https://packages.microsoft.com/repos/azure-cli/ ${AZURE_CLI_DIST} main" \
       > /etc/apt/sources.list.d/azure-cli.list \
    && apt-retry-install azure-cli

# ─── No pyjwt override ───
# This image used to `pip install --upgrade pyjwt==2.15.1` into azure-cli's
# bundled Python (/opt/az): azure-cli 2.90.0 shipped pyjwt 2.13.0, carrying
# GHSA-ffc3-869f-jxw9 (Critical, fixed in 2.14.0). Removed 2026-11-18, as the
# block itself instructed, because azure-cli now ships the fix: 2.92.0 and the
# current 2.93.0 bundle PyJWT 2.15.0 (src/azure-cli/requirements.py3.Linux.txt;
# no OSV advisory). If the gate ever flags /opt/az's pyjwt again, re-add an
# exact-pinned override. Check with:
#   docker run --rm <image> /opt/az/bin/python3 -c 'import jwt; print(jwt.__version__)'

# ─── Bundled-Python overrides (2026-11-25) ───
# azure-cli 2.93.0 (still the newest Microsoft serves) bundles, under
# /opt/az, cryptography 48.0.1 (CVE-2026-69247 / GHSA-g6cj-pr64-35w5 fixed in
# 50.0.0; CVE-2026-69249 / GHSA-jwv3-5hgf-82ww fixed in 49.0.0), urllib3 2.7.0
# (GHSA-8988-9cw3-xx77, GHSA-vxq7-64xx-v4gw; fixed in 2.8.0) and oauthlib 3.2.2
# (GHSA-7984-qgvg-3j9c; fixed in 4.0.0) — all High. Exact-pinned upgrades into
# that bundled interpreter; pyopenssl moves to 26.4.0 because 26.2.0 caps
# cryptography <49. Same pins as artifact/acr-push. `pip check` and
# `az --version` gate the build.
# Drop each pin once an azure-cli release bundles that version or newer.
RUN /opt/az/bin/python3 -m pip install --no-cache-dir --root-user-action=ignore \
       cryptography==50.0.2 pyopenssl==26.4.0 urllib3==2.8.0 oauthlib==4.0.1 \
    && /opt/az/bin/python3 -m pip check \
    && az --version >/dev/null

# ─── kubectl (built from source in the kubectl-build stage above) ───
COPY --from=kubectl-build /out/kubectl /usr/local/bin/kubectl

# ─── Runtime configuration defaults ───
# Non-sensitive config only — AZURE_CLIENT_ID, AZURE_CLIENT_SECRET, AZURE_TENANT_ID injected at runtime
ENV AZURE_SUBSCRIPTION=""
ENV AZURE_RESOURCE_GROUP=""
ENV DEPLOY_TYPE=webapp

# Working directory for pipeline source
WORKDIR /app
USER 1000:1000

# Default entrypoint — overridden by CodeBuildStep commands
CMD ["bash"]
