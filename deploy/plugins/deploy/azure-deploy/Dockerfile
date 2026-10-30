# Azure Deploy Plugin — Azure Infrastructure Deployment
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# Supports Web App, Container Instances, AKS, and Function deployments
# Includes Azure CLI and kubectl for infrastructure management

ARG KUBECTL_VERSION=1.37.2

FROM plugin-base:26.10

# Build steps below need root (apt, writes under /usr/local, /opt or /etc);
# the image drops back to the unprivileged `plugin` user (uid 1000) at the end.
USER root
ARG KUBECTL_VERSION

RUN apt-retry-install apt-transport-https lsb-release

# ─── Azure CLI ───
# Microsoft release-signing key pinned by fingerprint.
# Microsoft publishes the azure-cli apt repo per Ubuntu release and has none
# for 26.10 ("stonking": no Release file), so `lsb_release -cs` broke the
# build. Pinned to the newest one it serves; azure-cli bundles its own Python
# under /opt/az, so the noble package does not depend on the OS Python.
ARG AZURE_CLI_DIST=noble
RUN fetch-apt-key https://packages.microsoft.com/keys/microsoft.asc /usr/share/keyrings/microsoft.gpg \
       BC528686B50D79E339D3721CEB3E94ADBE1229CF \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/microsoft.gpg] https://packages.microsoft.com/repos/azure-cli/ ${AZURE_CLI_DIST} main" \
       > /etc/apt/sources.list.d/azure-cli.list \
    && apt-retry-install azure-cli

# ─── CVE remediation inside azure-cli's bundled Python ───
# azure-cli ships its own interpreter and site-packages under /opt/az, so its
# Python dependencies are NOT apt packages and do not move when the distro
# patches. 2.90.0 bundles pyjwt 2.13.0, which carries GHSA-ffc3-869f-jxw9
# (Critical, fixed in 2.14.0) — the single fixable Critical that failed this
# image's PLUGIN_VULN_GATE. Nothing in our Dockerfile selects that version;
# upgrading it in place is the only lever short of dropping azure-cli.
#
# Pinned exactly, like every other version here, so the image is reproducible.
# The gate is what tells you to move it: when a build fails on pyjwt again, bump
# this pin to the version the message names.
#
# DELETE this block once azure-cli itself ships a patched pyjwt — pip keeps the
# newer of the two, so a stale override would silently pin the CLI's dependency
# BELOW what Microsoft ships. Check with:
#   docker run --rm <image> /opt/az/bin/python3 -c 'import jwt; print(jwt.__version__)'
ARG AZ_PYJWT_VERSION=2.15.1
RUN set -eux; \
    /opt/az/bin/python3 -m pip install --no-cache-dir --upgrade "pyjwt==${AZ_PYJWT_VERSION}"; \
    /opt/az/bin/python3 -c "import jwt, sys; sys.exit(0 if jwt.__version__ == '${AZ_PYJWT_VERSION}' else 1)"; \
    az version --output tsv >/dev/null

# ─── kubectl ───
# Pinned version + pinned digest (dl.k8s.io's published kubectl.sha256 for
# this release), matching kubectl-deploy/helm-deploy.
ARG KUBECTL_SHA256_AMD64=c04487523e7aa7d1493f7808174c899db93d7a9cf57531420cd76b9bd415f8f4
ARG KUBECTL_SHA256_ARM64=fcc16f63186659d9722014b7e02d5fdd2d4e669cb8c0ab66365d7d3b8ba03509
RUN set -eux; \
    case "$(dpkg --print-architecture)" in \
      amd64) arch=amd64; sum="${KUBECTL_SHA256_AMD64}" ;; \
      arm64) arch=arm64; sum="${KUBECTL_SHA256_ARM64}" ;; \
      *) echo "unsupported architecture: $(dpkg --print-architecture)" >&2; exit 1 ;; \
    esac; \
    fetch-verified "https://dl.k8s.io/release/v${KUBECTL_VERSION}/bin/linux/${arch}/kubectl" "$sum" /usr/local/bin/kubectl; \
    chmod 0755 /usr/local/bin/kubectl

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
