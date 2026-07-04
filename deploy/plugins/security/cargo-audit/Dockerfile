# Cargo Audit Plugin — Dependency Vulnerability Scanner
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
#
# Thin layer over pipeline-rust-base (one pinned Rust toolchain, shared by all
# Rust plugins). cargo-audit is pinned + baked at build time — no runtime
# `cargo install` (deterministic, no network dependency at pipeline time).

FROM pipeline-rust-base:1.0

# TODO(confirm): verify the intended pinned cargo-audit version at build time.
ARG CARGO_AUDIT_VERSION=0.21.2
RUN cargo install cargo-audit --version "${CARGO_AUDIT_VERSION}"

WORKDIR /app
CMD ["bash"]
