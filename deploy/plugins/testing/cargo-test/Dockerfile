# Cargo Test Plugin — Rust Test Runner
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
#
# Thin layer over pipeline-rust-base — cargo/rustc are already on PATH from the
# base (single pinned toolchain), so nothing extra is installed here.

FROM pipeline-rust-base:1.0

WORKDIR /app
CMD ["bash"]
