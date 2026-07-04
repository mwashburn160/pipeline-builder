# Rust Plugin — Cargo build / test / lint
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
#
# Thin layer over pipeline-rust-base (one pinned Rust toolchain incl.
# clippy + rustfmt, shared by every Rust plugin). cargo/rustc/clippy/rustfmt
# are already on PATH from the base — no runtime rustup toolchain install
# (deterministic, no toolchain download at pipeline time).

FROM pipeline-rust-base:1.0

WORKDIR /app
CMD ["bash"]
