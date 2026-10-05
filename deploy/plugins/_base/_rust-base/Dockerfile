# Pipeline Builder — Shared Rust Base Image
#
# Build target tag: plugin-rust-base:1.0
#
# One pinned Rust toolchain (+ clippy/rustfmt), baked once, shared by every
# Rust plugin (cargo-test, cargo-publish, cargo-release, clippy, rustfmt,
# cargo-audit, and the snyk/trivy/sonarcloud Rust scanners). SINGLE-VERSION
# MODEL: one toolchain, no runtime `rustup toolchain install`.

FROM plugin-base:24.04

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

# Toolchain smoke test — RUN natively, SKIPPED when cross-building.
#
# Executing an amd64 rustc under QEMU on an arm64 host segfaults (signal 11,
# exit 139) even though the toolchain is perfectly sound and runs fine on a real
# amd64 node. Every other base image here survives emulation; Rust is the one
# that does not, which is why only this file carries the guard. Seen on a live
# eks deploy from an Apple Silicon workstation: the 10 other bases built, this
# one failed on exactly this line and took auto-init down with it.
#
# Deliberately NOT `|| true`. Masking the failure would turn a genuinely broken
# toolchain into a silent pass, and the whole point of this line is to catch
# that. Under emulation it asserts the strongest thing available without
# executing anything: that rustup installed every shim and they are executable.
ARG BUILDPLATFORM
ARG TARGETPLATFORM
RUN set -eux; \
    if [ -z "${BUILDPLATFORM:-}" ] || [ "${BUILDPLATFORM}" = "${TARGETPLATFORM}" ]; then \
      rustc --version; cargo --version; cargo clippy --version; cargo fmt --version; \
    else \
      echo "cross-build ${BUILDPLATFORM} -> ${TARGETPLATFORM}: skipping the run-time toolchain check (qemu segfaults an emulated rustc); verifying the install instead"; \
      for _b in rustc cargo cargo-clippy cargo-fmt rustfmt; do \
        test -x "${CARGO_HOME}/bin/${_b}" || { echo "rustup did not install ${CARGO_HOME}/bin/${_b}" >&2; exit 1; }; \
      done; \
    fi

WORKDIR /app
USER 1000:1000
CMD ["bash"]
