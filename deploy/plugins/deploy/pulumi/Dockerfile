# Pulumi Plugin — Infrastructure as Code Deployment
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# Supports TypeScript, Python, Go, and YAML programs

FROM plugin-aws-cli-base:1.0

# Build steps below need root (apt, writes under /opt); the image drops back
# to the unprivileged `plugin` user (uid 1000) at the end.
USER root

RUN apt-retry-install build-essential python3 python3-pip python3-venv

# ─── Node.js 24 ───
# Copied from plugin-node-base (one pinned, checksum-verified Node shared by
# every Node plugin) instead of `curl …/nvm/install.sh | bash` + `nvm install`.
# Laid out at the nvm path the plugin spec activates
# (`${NVM_DIR}/versions/node/v24/bin`), so the spec is unchanged; nvm itself is
# not installed (the spec never calls it).
ENV NVM_DIR=/opt/nvm
COPY --from=plugin-node-base:1.0 --chown=1000:1000 /opt/node ${NVM_DIR}/versions/node/v24
ENV PATH="${NVM_DIR}/versions/node/v24/bin:${PATH}"

# ─── Go ───
# Copied from plugin-go-base (pinned + checksum-verified Go ${GO_VERSION}, the
# same 1.24.13 goenv used to build here) instead of cloning goenv at HEAD.
# GOPATH is owned by uid 1000 so `go mod download` works as the runtime user.
COPY --from=plugin-go-base:1.0 /opt/go-sdk /opt/go-sdk
ENV GOPATH=/opt/go
ENV PATH="/opt/go-sdk/bin:${GOPATH}/bin:${PATH}"
RUN install -d -o 1000 -g 1000 "${GOPATH}" "${GOPATH}/bin"

# ─── Pulumi CLI ───
# Pinned release tarball + pinned digest (Pulumi's published
# pulumi-${PULUMI_VERSION}-checksums.txt) instead of `get.pulumi.com | bash`
# (which always installed latest).
#
# VULN FIX (2026-10-02): 3.264.0 vendored github.com/go-git/go-git@v6.0.0-alpha.4,
# vulnerable to a worktree symlink-traversal issue (CVE-2026-71556, fixed
# upstream in go-git v6.0.0-alpha.5). Pulumi picked up the fixed go-git in
# 3.266.0; bumped to the current latest stable, 3.267.0.
ARG PULUMI_VERSION=3.267.0
ARG PULUMI_SHA256_AMD64=527c1ce7c16cb38525a96d55422f221e819476e2b0743ae55c9862ad775ae10a
ARG PULUMI_SHA256_ARM64=e01a439cd1273819c9e836d86cc34c0bcca703a0dd06137c74053bcd49a45e6e
RUN set -eux; \
    case "$(dpkg --print-architecture)" in \
      amd64) arch=x64;   sum="${PULUMI_SHA256_AMD64}" ;; \
      arm64) arch=arm64; sum="${PULUMI_SHA256_ARM64}" ;; \
      *) echo "unsupported architecture: $(dpkg --print-architecture)" >&2; exit 1 ;; \
    esac; \
    fetch-verified "https://get.pulumi.com/releases/sdk/pulumi-v${PULUMI_VERSION}-linux-${arch}.tar.gz" "$sum" /tmp/pulumi.tar.gz; \
    mkdir -p /opt/pulumi/bin; \
    tar -xzf /tmp/pulumi.tar.gz -C /opt/pulumi/bin --strip-components=1; \
    rm -f /tmp/pulumi.tar.gz
ENV PATH="/opt/pulumi/bin:${PATH}"

RUN node --version && go version && pulumi version

# ─── Runtime configuration defaults ───
ENV PULUMI_ACTION=preview
ENV PULUMI_STACK=""
ENV PULUMI_RUNTIME=nodejs
ENV PULUMI_WORK_DIR=.

# Working directory for pipeline source
WORKDIR /app
USER 1000:1000

# Default entrypoint — overridden by CodeBuildStep commands
CMD ["bash"]
