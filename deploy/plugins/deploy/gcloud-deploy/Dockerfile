# GCP Deploy Plugin — Google Cloud Infrastructure Deployment
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# Supports App Engine, Cloud Run, GKE, and Compute Engine deployments
# Includes gcloud SDK, kubectl, and Terraform for infrastructure management

ARG KUBECTL_VERSION=1.37.3
ARG TERRAFORM_VERSION=1.17.2

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
ARG TERRAFORM_VERSION

RUN apt-retry-install apt-transport-https

# ─── Google Cloud SDK ───
# Google Artifact Registry repository-signing key pinned by fingerprint.
RUN fetch-apt-key https://packages.cloud.google.com/apt/doc/apt-key.gpg /usr/share/keyrings/cloud.google.gpg \
       35BAA0B33E9EB396F59CA838C0BA5CE6DC6315A3 \
    && echo "deb [signed-by=/usr/share/keyrings/cloud.google.gpg] https://packages.cloud.google.com/apt cloud-sdk main" \
       > /etc/apt/sources.list.d/google-cloud-sdk.list \
    && apt-retry-install google-cloud-cli google-cloud-cli-gke-gcloud-auth-plugin

# ─── kubectl (built from source in the kubectl-build stage above) ───
COPY --from=kubectl-build /out/kubectl /usr/local/bin/kubectl

# ─── Terraform ───
# Pinned version + pinned digest (HashiCorp's published SHA256SUMS for this
# release). Bumping = change TERRAFORM_VERSION and both digests together.
ARG TERRAFORM_SHA256_AMD64=e6f16b2f0b137ee5729caa8c4e79a3bae4ee261acd198a1fcfa8584a6296605b
ARG TERRAFORM_SHA256_ARM64=858e08c181a76b6b223e8c767a8e983922eebe2d062db949a2de66ce040c368c
RUN set -eux; \
    case "$(dpkg --print-architecture)" in \
      amd64) arch=amd64; sum="${TERRAFORM_SHA256_AMD64}" ;; \
      arm64) arch=arm64; sum="${TERRAFORM_SHA256_ARM64}" ;; \
      *) echo "unsupported architecture: $(dpkg --print-architecture)" >&2; exit 1 ;; \
    esac; \
    fetch-verified "https://releases.hashicorp.com/terraform/${TERRAFORM_VERSION}/terraform_${TERRAFORM_VERSION}_linux_${arch}.zip" "$sum" /tmp/terraform.zip; \
    unzip -q /tmp/terraform.zip terraform -d /usr/local/bin; \
    rm -f /tmp/terraform.zip; \
    terraform version

# ─── Runtime configuration defaults ───
# Non-sensitive config only — GOOGLE_APPLICATION_CREDENTIALS injected at runtime via CodeBuild secrets
ENV GCP_PROJECT=""
ENV GCP_REGION=us-central1
ENV DEPLOY_TYPE=app-engine

# Working directory for pipeline source
WORKDIR /app
USER 1000:1000

# Default entrypoint — overridden by CodeBuildStep commands
CMD ["bash"]
