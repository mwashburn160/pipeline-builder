# Dockerfile AI Generator Plugin — Multi-provider AI-powered Dockerfile generation
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# Analyzes project source code and generates an optimized Dockerfile
# Supports: Anthropic (Claude), OpenAI (GPT), Google (Gemini), xAI (Grok), Amazon Bedrock
# Set AI_PROVIDER and AI_MODEL to select provider/model
#
# Built on the AWS CLI family base: the `bedrock` provider calls
# `aws bedrock-runtime invoke-model`, which plugin-base:26.10 does not carry.

# ─── Tool versions (override with --build-arg) ───
ARG HADOLINT_VERSION=2.15.1

FROM plugin-aws-cli-base:1.0

# Build steps below need root (writes under /usr/local);
# the image drops back to the unprivileged `plugin` user (uid 1000) at the end.
USER root

# Re-declare ARGs after FROM so they're available in this stage
ARG HADOLINT_VERSION
# Digests from the release's own checksums.sha256
# (github.com/hadolint/hadolint/releases/download/v2.15.1/checksums.sha256).
ARG HADOLINT_SHA256_AMD64=c7187db94eeeeca956519a6af171adc31453941a1e777961f6e680f697c8c507
ARG HADOLINT_SHA256_ARM64=f6198ef8090f404dbb771abfee086eb8c48ac177f30da7fd3510aca35b344b5d

# ─── Hadolint — lints the generated Dockerfile before it is handed on ───
RUN set -eux; \
    case "$(dpkg --print-architecture)" in \
      amd64) arch=x86_64; sum="${HADOLINT_SHA256_AMD64}" ;; \
      arm64) arch=arm64;  sum="${HADOLINT_SHA256_ARM64}" ;; \
      *) echo "unsupported architecture: $(dpkg --print-architecture)" >&2; exit 1 ;; \
    esac; \
    fetch-verified "https://github.com/hadolint/hadolint/releases/download/v${HADOLINT_VERSION}/hadolint-linux-${arch}" "$sum" /usr/local/bin/hadolint; \
    chmod 0755 /usr/local/bin/hadolint; \
    hadolint --version

# Runtime configuration defaults
# Non-sensitive config only — API keys must be injected at runtime
# via CodeBuild environment variables or secrets manager.
# AI_MODEL empty = the provider's current default (see plugin-spec.yaml).
ENV HADOLINT_VERSION=${HADOLINT_VERSION}
ENV AI_PROVIDER=anthropic
ENV AI_MODEL=""

# Working directory for pipeline source
WORKDIR /app
USER 1000:1000

# Default entrypoint — overridden by CodeBuildStep commands
CMD ["bash"]
