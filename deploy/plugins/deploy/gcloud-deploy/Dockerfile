# GCP Deploy Plugin — Google Cloud Infrastructure Deployment
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# Supports App Engine, Cloud Run, GKE, and Compute Engine deployments
# Includes gcloud SDK, kubectl, and Terraform for infrastructure management

ARG KUBECTL_VERSION=1.37.0
ARG TERRAFORM_VERSION=1.16.3

FROM pipeline-plugin-base:24.04

# Build steps below need root (apt, writes under /usr/local, /opt or /etc);
# the image drops back to the unprivileged `plugin` user (uid 1000) at the end.
USER root
ARG KUBECTL_VERSION
ARG TERRAFORM_VERSION

RUN apt-retry-install apt-transport-https

# ─── Google Cloud SDK ───
# Google Artifact Registry repository-signing key pinned by fingerprint.
RUN fetch-apt-key https://packages.cloud.google.com/apt/doc/apt-key.gpg /usr/share/keyrings/cloud.google.gpg \
       35BAA0B33E9EB396F59CA838C0BA5CE6DC6315A3 \
    && echo "deb [signed-by=/usr/share/keyrings/cloud.google.gpg] https://packages.cloud.google.com/apt cloud-sdk main" \
       > /etc/apt/sources.list.d/google-cloud-sdk.list \
    && apt-retry-install google-cloud-cli google-cloud-cli-gke-gcloud-auth-plugin

# ─── kubectl ───
# Pinned version + pinned digest (dl.k8s.io's published kubectl.sha256 for
# this release), matching kubectl-deploy/helm-deploy.
ARG KUBECTL_SHA256_AMD64=6129359f4e1f3848a5572ccb0b26cf28b8ca08cef38c95a765b2f64a2c961a2f
ARG KUBECTL_SHA256_ARM64=922df28df248cc00a9e025f947704f1d1482de64ece54cfe57e61f19eaf1eef3
RUN set -eux; \
    case "$(dpkg --print-architecture)" in \
      amd64) arch=amd64; sum="${KUBECTL_SHA256_AMD64}" ;; \
      arm64) arch=arm64; sum="${KUBECTL_SHA256_ARM64}" ;; \
      *) echo "unsupported architecture: $(dpkg --print-architecture)" >&2; exit 1 ;; \
    esac; \
    fetch-verified "https://dl.k8s.io/release/v${KUBECTL_VERSION}/bin/linux/${arch}/kubectl" "$sum" /usr/local/bin/kubectl; \
    chmod 0755 /usr/local/bin/kubectl

# ─── Terraform ───
# Pinned version + pinned digest (HashiCorp's published SHA256SUMS for this
# release). Bumping = change TERRAFORM_VERSION and both digests together.
ARG TERRAFORM_SHA256_AMD64=093b6ae9a2228af5029c41606bc96eb583553528aad1bfe7e0b4d62fc91e25d8
ARG TERRAFORM_SHA256_ARM64=b6b293550af7a6a7ffd867a04900ce161db86ec9407b234a636c2adbae2ca9f0
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
