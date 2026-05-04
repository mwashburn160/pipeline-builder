# Cargo Audit Plugin — Dependency Vulnerability Scanner
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder

FROM pipeline-plugin-base:24.04

RUN apt-get update && apt-get install -y --no-install-recommends \
    git zip unzip curl jq ca-certificates build-essential libssl-dev pkg-config \
    && rm -rf /var/lib/apt/lists/*

ENV RUSTUP_HOME=/opt/rustup
ENV CARGO_HOME=/opt/cargo
RUN curl -fsSL https://sh.rustup.rs | sh -s -- -y --default-toolchain stable --no-modify-path

RUN /opt/cargo/bin/rustup toolchain install stable && \
    /opt/cargo/bin/rustup toolchain install 1.84.0 && \
    /opt/cargo/bin/rustup component add clippy rustfmt

ENV PATH="${CARGO_HOME}/bin:${PATH}"
ENV RUST_VERSION=stable

WORKDIR /app
CMD ["bash"]
