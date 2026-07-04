# Cargo Publish Plugin — Publish crates to crates.io
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# Publishes Rust crates to crates.io with dry-run support.
# Requires CARGO_REGISTRY_TOKEN injected at runtime via CodeBuild secrets.
#
# Thin layer over pipeline-rust-base — cargo is already on PATH from the base
# (single pinned toolchain), so nothing extra is installed here.

FROM pipeline-rust-base:1.0

WORKDIR /app
CMD ["bash"]
