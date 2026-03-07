# Snyk Security Plugin — Rust scanning
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder

FROM public.ecr.aws/docker/library/ubuntu:24.04

# Avoid interactive prompts
ENV DEBIAN_FRONTEND=noninteractive

# System dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    curl \
    jq \
    ca-certificates \
    build-essential \
    gnupg \
    pkg-config \
    libssl-dev \
    && rm -rf /var/lib/apt/lists/*

# ─── Node.js (required by Snyk CLI) ───
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# ─── Rust via rustup ───
ENV RUSTUP_HOME=/opt/rustup
ENV CARGO_HOME=/opt/cargo
RUN curl -fsSL https://sh.rustup.rs | sh -s -- -y --default-toolchain stable --no-modify-path \
    && /opt/cargo/bin/rustup toolchain install 1.84.0
ENV PATH="${CARGO_HOME}/bin:${PATH}"

# ─── Snyk CLI ───
RUN npm install -g snyk

# ─── Runtime configuration defaults ───
ENV SNYK_SEVERITY_THRESHOLD=high
ENV RUST_VERSION=stable

# Working directory for pipeline source
WORKDIR /app

CMD ["bash"]
