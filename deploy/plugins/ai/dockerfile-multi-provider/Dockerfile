# Dockerfile AI Generator Plugin — Multi-provider AI-powered Dockerfile generation
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# Analyzes project source code and generates an optimized Dockerfile
# Supports: Anthropic (Claude), OpenAI (GPT), Google (Gemini), xAI (Grok)
# Set AI_PROVIDER and AI_MODEL to select provider/model

FROM public.ecr.aws/docker/library/ubuntu:24.04

# Avoid interactive prompts
ENV DEBIAN_FRONTEND=noninteractive

# Accept default config for any package prompts
RUN echo 'Dpkg::Options { "--force-confnew"; }' > /etc/apt/apt.conf.d/99force-confnew

# System dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    curl \
    jq \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Runtime configuration defaults
# Non-sensitive config only — API keys must be injected at runtime
# via CodeBuild environment variables or secrets manager
ENV AI_PROVIDER=anthropic
ENV AI_MODEL=claude-sonnet-4-20250514

# Working directory for pipeline source
WORKDIR /app

# Default entrypoint — overridden by CodeBuildStep commands
CMD ["bash"]
