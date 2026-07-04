# Pipeline Builder — Shared C/C++ Base Image
#
# Build target tag: pipeline-cpp-base:1.0
#
# One pinned C/C++ toolchain + build systems, baked once. SINGLE-VERSION MODEL:
# Ubuntu 24.04's apt provides the compiler/tool versions (fixed by the distro);
# Conan + Meson are pip-pinned. Bump and rebuild to change.

FROM pipeline-plugin-base:24.04

# C/C++ toolchain + build systems + analysis tools. (git/curl/jq/unzip are in
# _plugin-base; not repeated here.)
RUN apt-retry-install build-essential cmake clang ninja-build pkg-config \
    libssl-dev valgrind cppcheck python3 python3-pip

# Conan (deps) + Meson (build), pinned. --break-system-packages: Ubuntu 24.04's
# python3 is PEP-668 externally-managed; these are the image's own tools.
ARG CONAN_VERSION=2.9.2
ARG MESON_VERSION=1.6.1
RUN pip3 install --no-cache-dir --break-system-packages \
    "conan==${CONAN_VERSION}" "meson==${MESON_VERSION}"

# Build-system selection (auto = detect from project files) + build type.
ENV BUILD_SYSTEM=auto
ENV BUILD_TYPE=Release

RUN gcc --version | head -1 && cmake --version | head -1 && conan --version && meson --version

WORKDIR /app
CMD ["bash"]
