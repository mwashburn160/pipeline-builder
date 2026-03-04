# Snyk Security Plugin — Multi-language, multi-version build environment
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# Node.js is the default runtime (also required by Snyk CLI)
# Set LANGUAGE to activate a different runtime: python, java, go, dotnet, cpp, ruby, rust
# Set LANGUAGE_VERSION to select the specific version

FROM public.ecr.aws/docker/library/ubuntu:24.04

# Avoid interactive prompts
ENV DEBIAN_FRONTEND=noninteractive

# System dependencies for Snyk scanning + language compilation prerequisites
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
    software-properties-common \
    && rm -rf /var/lib/apt/lists/*

# ─── Node.js (default runtime, also required by Snyk CLI) ───
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
# Add cmake and clang for broader C++ project support
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

# ─── Snyk CLI via svm (Snyk Version Manager) ───
ENV SVM_DIR=/opt/svm
RUN mkdir -p ${SVM_DIR} \
    && curl -fsSL https://static.snyk.io/cli/releases/svm/v3/svm-linux -o ${SVM_DIR}/svm \
    && chmod +x ${SVM_DIR}/svm
ENV PATH="${SVM_DIR}:${PATH}"

# Pre-install common Snyk CLI versions so builds are fast
RUN svm install 1.1291.0 && \
    svm install 1.1293.0 && \
    svm install latest && \
    svm use latest

# ─── Runtime configuration defaults ───
# Non-sensitive config only — sensitive values (SNYK_TOKEN) must be
# injected at runtime via CodeBuild environment variables or secrets manager
ENV SNYK_VERSION=latest
ENV SNYK_SEVERITY_THRESHOLD=high

# Language selection (nodejs = default, set to python/java/go/dotnet/cpp/ruby/rust to switch)
ENV LANGUAGE=nodejs
ENV LANGUAGE_VERSION=""

# Working directory for pipeline source
WORKDIR /app

# Default entrypoint — overridden by CodeBuildStep commands
CMD ["bash"]
