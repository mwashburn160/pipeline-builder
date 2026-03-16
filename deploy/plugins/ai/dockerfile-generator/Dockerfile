# Dockerfile Generator Plugin — AI-powered Dockerfile generation using Ollama
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# Analyzes project source code and generates an optimized Dockerfile

FROM public.ecr.aws/docker/library/ubuntu:24.04

# Avoid interactive prompts
ENV DEBIAN_FRONTEND=noninteractive

# System dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    curl \
    jq \
    ca-certificates \
    zstd \
    && rm -rf /var/lib/apt/lists/*

# Install Node.js (for generation script)
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# Install Ollama (tar.zst — only format available since v0.17+)
RUN ARCH=$(dpkg --print-architecture) && curl -fsSL -L "https://ollama.com/download/ollama-linux-${ARCH}.tar.zst" | tar --zstd -x -C /usr

# Runtime configuration defaults
# OLLAMA_MODEL: Which model to use for generation (must be pulled at runtime)
# OLLAMA_HOST: Ollama server URL (default: local)
# OLLAMA_NUM_CTX: Context window size for the model
# OLLAMA_NO_GPU: Force CPU-only mode (works on non-GPU instances)
ENV OLLAMA_MODEL=codellama:7b
ENV OLLAMA_HOST=http://localhost:11434
ENV OLLAMA_NUM_CTX=8192
ENV OLLAMA_NO_GPU=1

# Working directory for pipeline source
WORKDIR /app

# Default entrypoint — overridden by CodeBuildStep commands
CMD ["bash"]
