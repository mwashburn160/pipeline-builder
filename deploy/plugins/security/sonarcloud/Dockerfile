# SonarCloud Plugin — Multi-language, multi-version build environment
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# Node.js is the default runtime
# Set LANGUAGE to activate a different runtime: python, java, go, dotnet, cpp, ruby, rust
# Set LANGUAGE_VERSION to select the specific version

# ─── Tool versions (override with --build-arg) ───
ARG SONAR_DEFAULT_VERSION=6.2.1.4610
ARG SONAR_PREV_VERSION=6.1.0.4477

FROM sonarsource/sonar-scanner-cli:${SONAR_DEFAULT_VERSION} AS scanner-default
FROM sonarsource/sonar-scanner-cli:${SONAR_PREV_VERSION} AS scanner-prev

FROM public.ecr.aws/docker/library/ubuntu:24.04

# Re-declare ARGs after FROM so they're available in this stage
ARG SONAR_DEFAULT_VERSION
ARG SONAR_PREV_VERSION

# Avoid interactive prompts
ENV DEBIAN_FRONTEND=noninteractive

# System dependencies for SonarCloud scanning + language compilation prerequisites
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    zip \
    unzip \
    curl \
    wget \
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
    libyaml-dev \
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
# Note: Java 17+ is also required by sonar-scanner CLI
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

# ─── SonarScanner CLI (copied from official images) ───
RUN mkdir -p /opt/sonar-scanner/versions
COPY --from=scanner-default /opt/sonar-scanner /opt/sonar-scanner/versions/scanner-${SONAR_DEFAULT_VERSION}
COPY --from=scanner-prev /opt/sonar-scanner /opt/sonar-scanner/versions/scanner-${SONAR_PREV_VERSION}

# Default to latest installed version
RUN ln -sf /opt/sonar-scanner/versions/scanner-${SONAR_DEFAULT_VERSION}/bin/sonar-scanner /usr/local/bin/sonar-scanner

# ─── Runtime configuration defaults ───
# Non-sensitive config only — SONAR_TOKEN must be injected at runtime
# via CodeBuild environment variables or secrets manager
ENV SONAR_SCANNER_VERSION=${SONAR_DEFAULT_VERSION}
ENV SONAR_ORGANIZATION=""
ENV SONAR_PROJECT_KEY=""

# Language selection (nodejs = default, set to python/java/go/dotnet/cpp/ruby/rust to switch)
ENV LANGUAGE=nodejs
ENV LANGUAGE_VERSION=""

# Working directory for pipeline source
WORKDIR /app

# Default entrypoint — overridden by CodeBuildStep commands
CMD ["bash"]
