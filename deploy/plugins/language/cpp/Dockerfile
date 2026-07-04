# C++ Plugin — Build environment with cmake, make, clang, meson, conan
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
#
# Thin layer over pipeline-cpp-base (one pinned C/C++ toolchain + Conan/Meson,
# BUILD_SYSTEM/BUILD_TYPE knobs baked in). Nothing plugin-specific to add.

FROM pipeline-cpp-base:1.0

WORKDIR /app
CMD ["bash"]
