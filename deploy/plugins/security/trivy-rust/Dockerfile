# Trivy Security Plugin — Rust scanning
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
#
# Inherits from the trivy family base image (pipeline-trivy-base:1.0)
# which provides trivy CLI + (where applicable) Node.js. This file
# only adds the Rust toolchain.

FROM pipeline-trivy-base:1.0

# ─── Rust via rustup ───
ENV RUSTUP_HOME=/opt/rustup
ENV CARGO_HOME=/opt/cargo
RUN curl -fsSL https://sh.rustup.rs | sh -s -- -y --default-toolchain stable --no-modify-path
ENV PATH="${CARGO_HOME}/bin:${PATH}"
ENV RUST_VERSION=stable

WORKDIR /app
CMD ["bash"]
