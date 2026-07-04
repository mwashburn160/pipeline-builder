# Cargo Release Plugin — Release Binary Builder
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
#
# Thin layer over pipeline-rust-base — cargo/rustc are already on PATH from the
# base (single pinned toolchain). Cross-compilation targets are added at
# runtime via `rustup target add` (see plugin-spec.yaml).

FROM pipeline-rust-base:1.0

WORKDIR /app
CMD ["bash"]
