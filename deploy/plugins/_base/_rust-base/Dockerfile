# Pipeline Builder — Shared Rust Base Image
#
# Build target tag: pipeline-rust-base:1.0
#
# One pinned Rust toolchain (+ clippy/rustfmt), baked once, shared by every
# Rust plugin (cargo-test, cargo-publish, cargo-release, clippy, rustfmt,
# cargo-audit, and the snyk/trivy/sonarcloud Rust scanners). SINGLE-VERSION
# MODEL: one toolchain, no runtime `rustup toolchain install`.

FROM pipeline-plugin-base:24.04

USER root

RUN apt-retry-install build-essential libssl-dev pkg-config

# Single pinned Rust toolchain. rustup-init itself is a pinned release,
# verified against the .sha256 static.rust-lang.org publishes beside it (no
# `curl https://sh.rustup.rs | sh`); rustup then verifies each toolchain
# component against the channel manifest's SHA-256s. RUSTUP_HOME/CARGO_HOME
# are owned by the plugin user so `cargo build` (registry cache in CARGO_HOME)
# and `cargo install` work non-root.
ENV RUSTUP_HOME=/opt/rustup
ENV CARGO_HOME=/opt/cargo
ARG RUST_VERSION=1.98.1
ARG RUSTUP_VERSION=1.29.1
ARG RUSTUP_SHA256_AMD64=dda7234360b7f578ca8b0ddcb80145646fa61a67c1720a5abc7051b35c9fcb71
ARG RUSTUP_SHA256_ARM64=15f6e4ce9f583b929c996c91562bad6d4454f3281de858b02cdfdef615fac433
RUN set -eux; \
    case "$(dpkg --print-architecture)" in \
      amd64) triple=x86_64-unknown-linux-gnu;  sum="${RUSTUP_SHA256_AMD64}" ;; \
      arm64) triple=aarch64-unknown-linux-gnu; sum="${RUSTUP_SHA256_ARM64}" ;; \
      *) echo "unsupported architecture: $(dpkg --print-architecture)" >&2; exit 1 ;; \
    esac; \
    fetch-verified "https://static.rust-lang.org/rustup/archive/${RUSTUP_VERSION}/${triple}/rustup-init" "$sum" /tmp/rustup-init; \
    chmod +x /tmp/rustup-init; \
    /tmp/rustup-init -y --no-modify-path --profile minimal --default-toolchain "${RUST_VERSION}" \
      --component clippy --component rustfmt; \
    rm -f /tmp/rustup-init; \
    chown -R 1000:1000 "${RUSTUP_HOME}" "${CARGO_HOME}"

ENV PATH="${CARGO_HOME}/bin:${PATH}"
ENV RUST_VERSION=${RUST_VERSION}

RUN rustc --version && cargo --version && cargo clippy --version && cargo fmt --version

WORKDIR /app
USER 1000:1000
CMD ["bash"]
