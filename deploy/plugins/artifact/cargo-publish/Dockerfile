# Cargo Publish Plugin — Publish crates to crates.io
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# Publishes Rust crates to crates.io with dry-run support
# Requires CARGO_REGISTRY_TOKEN injected at runtime via CodeBuild secrets

FROM pipeline-plugin-base:24.04

RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    zip \
    unzip \
    curl \
    jq \
    ca-certificates \
    build-essential \
    libssl-dev \
    pkg-config \
    && rm -rf /var/lib/apt/lists/*

# ─── Rust via rustup (stable toolchain) ───
ENV RUSTUP_HOME=/opt/rustup
ENV CARGO_HOME=/opt/cargo
RUN curl -fsSL https://sh.rustup.rs | sh -s -- -y --default-toolchain stable --no-modify-path

# Add Rust to PATH
ENV PATH="${CARGO_HOME}/bin:${PATH}"

# ─── Runtime configuration defaults ───
# Non-sensitive config only — CARGO_REGISTRY_TOKEN injected at runtime via CodeBuild secrets
ENV CARGO_DRY_RUN=false

# Working directory for pipeline source
WORKDIR /app

# Default entrypoint — overridden by CodeBuildStep commands
CMD ["bash"]
