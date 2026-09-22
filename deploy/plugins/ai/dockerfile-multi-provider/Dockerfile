# Dockerfile AI Generator Plugin — Multi-provider AI-powered Dockerfile generation
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# Analyzes project source code and generates an optimized Dockerfile
# Supports: Anthropic (Claude), OpenAI (GPT), Google (Gemini), xAI (Grok)
# Set AI_PROVIDER and AI_MODEL to select provider/model

FROM pipeline-plugin-base:24.04

# Build steps below need root (apt, writes under /usr/local, /opt or /etc);
# the image drops back to the unprivileged `plugin` user (uid 1000) at the end.
USER root

# Accept default config for any package prompts
RUN echo 'Dpkg::Options { "--force-confnew"; }' > /etc/apt/apt.conf.d/99force-confnew

# Runtime configuration defaults
# Non-sensitive config only — API keys must be injected at runtime
# via CodeBuild environment variables or secrets manager
ENV AI_PROVIDER=anthropic
ENV AI_MODEL=claude-sonnet-4-20250514

# Working directory for pipeline source
WORKDIR /app
USER 1000:1000

# Default entrypoint — overridden by CodeBuildStep commands
CMD ["bash"]
