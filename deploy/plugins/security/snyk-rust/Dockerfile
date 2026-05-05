# Snyk Security Plugin — Rust scanning
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
#
# Inherits from the snyk family base image (pipeline-snyk-base:1.0)
# which provides snyk CLI + (where applicable) Node.js. This file
# only adds the Rust toolchain.

FROM pipeline-snyk-base:1.0

# Build deps required by the language toolchain. Without these, the
# scanner fails when it needs to build user code with native deps
# (cgo, JNI, native crates, native NuGet packages, etc.).
RUN apt-retry-install build-essential libssl-dev pkg-config

# ─── Rust via rustup ───
ENV RUSTUP_HOME=/opt/rustup
ENV CARGO_HOME=/opt/cargo
RUN curl -fsSL https://sh.rustup.rs | sh -s -- -y --default-toolchain stable --no-modify-path
ENV PATH="${CARGO_HOME}/bin:${PATH}"
ENV RUST_VERSION=stable

WORKDIR /app
CMD ["bash"]
