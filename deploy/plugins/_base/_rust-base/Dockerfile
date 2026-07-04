# Pipeline Builder — Shared Rust Base Image
#
# Build target tag: pipeline-rust-base:1.0
#
# One pinned Rust toolchain (+ clippy/rustfmt), baked once, shared by every
# Rust plugin (cargo-test, cargo-publish, cargo-release, clippy, rustfmt,
# cargo-audit, and the snyk/trivy/sonarcloud Rust scanners). SINGLE-VERSION
# MODEL: one toolchain, no runtime `rustup toolchain install`.

FROM pipeline-plugin-base:24.04

RUN apt-retry-install build-essential libssl-dev pkg-config

# Single Rust toolchain via rustup (installer only; no runtime switching).
ENV RUSTUP_HOME=/opt/rustup
ENV CARGO_HOME=/opt/cargo
ARG RUST_VERSION=stable
RUN curl -fsSL https://sh.rustup.rs | sh -s -- -y --default-toolchain "${RUST_VERSION}" --no-modify-path \
    && /opt/cargo/bin/rustup component add clippy rustfmt

ENV PATH="${CARGO_HOME}/bin:${PATH}"
ENV RUST_VERSION=${RUST_VERSION}

RUN rustc --version && cargo --version && cargo clippy --version && cargo fmt --version

WORKDIR /app
CMD ["bash"]
