# Rust Plugin — Multi-version build environment using rustup
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# Rust version is selected at runtime via RUST_VERSION env var

FROM pipeline-plugin-base:24.04

# System dependencies for builds
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    libssl-dev \
    pkg-config \
    && rm -rf /var/lib/apt/lists/*

# Install Rust via rustup
ENV RUSTUP_HOME=/opt/rustup
ENV CARGO_HOME=/opt/cargo
RUN curl -fsSL https://sh.rustup.rs | sh -s -- -y --default-toolchain stable --no-modify-path

# Pre-install current + previous Rust toolchains
RUN /opt/cargo/bin/rustup toolchain install stable && \
    /opt/cargo/bin/rustup toolchain install 1.84.0 && \
    /opt/cargo/bin/rustup component add clippy rustfmt

# Add Rust to PATH
ENV PATH="${CARGO_HOME}/bin:${PATH}"

# Default Rust version (overridden by RUST_VERSION env var at runtime)
ENV RUST_VERSION=stable

# Working directory for pipeline source
WORKDIR /app

# Default entrypoint — overridden by CodeBuildStep commands
CMD ["bash"]
