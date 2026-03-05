# Trivy Security Plugin — Multi-language, multi-version build environment
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# Node.js is the default runtime
# Set LANGUAGE to activate a different runtime: python, java, go, dotnet, cpp, ruby, rust
# Set LANGUAGE_VERSION to select the specific version

# ─── Tool versions (override with --build-arg) ───
ARG TRIVY_VERSION=0.69.3
ARG TRIVY_PREV_VERSION=0.26.0

FROM aquasec/trivy:${TRIVY_VERSION} AS trivy-default
FROM aquasec/trivy:${TRIVY_PREV_VERSION} AS trivy-prev

FROM public.ecr.aws/docker/library/ubuntu:24.04

ARG TRIVY_VERSION
ARG TRIVY_PREV_VERSION

# Avoid interactive prompts
ENV DEBIAN_FRONTEND=noninteractive

# System dependencies for Trivy scanning + language compilation prerequisites
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    zip \
    unzip \
    curl \
    jq \
    ca-certificates \
    build-essential \
    gnupg \
    libssl-dev \
    zlib1g-dev \
    libbz2-dev \
    libreadline-dev \
    libsqlite3-dev \
    libncursesw5-dev \
    libxml2-dev \
    libxmlsec1-dev \
    libffi-dev \
    liblzma-dev \
    software-properties-common \
    && rm -rf /var/lib/apt/lists/*

# ─── Node.js (default runtime) ───
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# ─── Python via pyenv (activated when PYTHON_VERSION is set) ───
ENV PYENV_ROOT=/opt/pyenv
RUN curl -fsSL https://pyenv.run | bash
RUN /opt/pyenv/bin/pyenv install 3.11 && \
    /opt/pyenv/bin/pyenv install 3.12 && \
    /opt/pyenv/bin/pyenv install 3.13
ENV PATH="/opt/pyenv/shims:/opt/pyenv/bin:${PATH}"

# ─── Java via SDKMAN (activated when JAVA_VERSION is set) ───
ENV SDKMAN_DIR=/opt/sdkman
RUN curl -fsSL "https://get.sdkman.io?rcupdate=false" | bash
RUN bash -c "source ${SDKMAN_DIR}/bin/sdkman-init.sh && \
    sdk install java 17.0.18-tem && \
    sdk install java 21.0.10-tem && \
    sdk install maven 3.9.9 && \
    sdk install gradle 8.12"
ENV PATH="${SDKMAN_DIR}/candidates/java/current/bin:${SDKMAN_DIR}/candidates/maven/current/bin:${SDKMAN_DIR}/candidates/gradle/current/bin:${SDKMAN_DIR}/bin:${PATH}"

# ─── Go via goenv (activated when GO_VERSION is set) ───
ENV GOENV_ROOT=/opt/goenv
RUN git clone https://github.com/go-nv/goenv.git ${GOENV_ROOT}
RUN ${GOENV_ROOT}/bin/goenv install 1.21.13 && \
    ${GOENV_ROOT}/bin/goenv install 1.22.10 && \
    ${GOENV_ROOT}/bin/goenv install 1.23.5
ENV PATH="${GOENV_ROOT}/shims:${GOENV_ROOT}/bin:${PATH}"

# ─── .NET SDK (activated when LANGUAGE=dotnet) ───
RUN curl -fsSL https://dot.net/v1/dotnet-install.sh -o /tmp/dotnet-install.sh \
    && chmod +x /tmp/dotnet-install.sh \
    && /tmp/dotnet-install.sh --channel 8.0 --install-dir /opt/dotnet \
    && /tmp/dotnet-install.sh --channel 9.0 --install-dir /opt/dotnet \
    && rm /tmp/dotnet-install.sh
ENV DOTNET_ROOT=/opt/dotnet
ENV PATH="${DOTNET_ROOT}:${DOTNET_ROOT}/tools:${PATH}"
ENV DOTNET_CLI_TELEMETRY_OPTOUT=1

# ─── C++ build tools (activated when LANGUAGE=cpp) ───
# build-essential already installed above (gcc/g++/make)
RUN apt-get update && apt-get install -y --no-install-recommends \
    cmake \
    clang \
    ninja-build \
    pkg-config \
    && rm -rf /var/lib/apt/lists/*

# ─── Ruby via rbenv (activated when LANGUAGE=ruby) ───
ENV RBENV_ROOT=/opt/rbenv
RUN git clone https://github.com/rbenv/rbenv.git ${RBENV_ROOT} \
    && git clone https://github.com/rbenv/ruby-build.git ${RBENV_ROOT}/plugins/ruby-build
RUN ${RBENV_ROOT}/bin/rbenv install 3.2.10 && \
    ${RBENV_ROOT}/bin/rbenv install 3.3.10
ENV PATH="${RBENV_ROOT}/shims:${RBENV_ROOT}/bin:${PATH}"

# ─── Rust via rustup (activated when LANGUAGE=rust) ───
ENV RUSTUP_HOME=/opt/rustup
ENV CARGO_HOME=/opt/cargo
RUN curl -fsSL https://sh.rustup.rs | sh -s -- -y --default-toolchain stable --no-modify-path \
    && /opt/cargo/bin/rustup toolchain install 1.83.0
ENV PATH="${CARGO_HOME}/bin:${PATH}"

# ─── Trivy CLI — multi-version support (copied from official images) ───
RUN mkdir -p /opt/trivy/versions
COPY --from=trivy-prev /usr/local/bin/trivy /opt/trivy/versions/trivy-${TRIVY_PREV_VERSION}
COPY --from=trivy-default /usr/local/bin/trivy /opt/trivy/versions/trivy-${TRIVY_VERSION}
RUN ln -sf /opt/trivy/versions/trivy-${TRIVY_VERSION} /usr/local/bin/trivy

# ─── Runtime configuration defaults ───
ENV TRIVY_VERSION=${TRIVY_VERSION}
ENV TRIVY_SEVERITY=HIGH,CRITICAL
ENV TRIVY_FORMAT=json

# Language selection (nodejs = default, set to python/java/go/dotnet/cpp/ruby/rust to switch)
ENV LANGUAGE=nodejs
ENV LANGUAGE_VERSION=""

# Working directory for pipeline source
WORKDIR /app

# Default entrypoint — overridden by CodeBuildStep commands
CMD ["bash"]
