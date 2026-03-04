# Fastlane Plugin — Mobile Build and Distribution
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# Provides containerized environment for Android builds and Fastlane lane execution
# NOTE: iOS builds require macOS; this container supports Android builds and lane orchestration

FROM public.ecr.aws/docker/library/ubuntu:24.04

# Avoid interactive prompts
ENV DEBIAN_FRONTEND=noninteractive

# System dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    zip \
    unzip \
    curl \
    wget \
    jq \
    ca-certificates \
    gnupg \
    build-essential \
    libssl-dev \
    zlib1g-dev \
    libreadline-dev \
    libyaml-dev \
    libffi-dev \
    openjdk-17-jre-headless \
    && rm -rf /var/lib/apt/lists/*

# ─── Ruby 3.3 via rbenv ───
ENV RBENV_ROOT=/opt/rbenv
RUN git clone --depth 1 https://github.com/rbenv/rbenv.git ${RBENV_ROOT} \
    && git clone --depth 1 https://github.com/rbenv/ruby-build.git ${RBENV_ROOT}/plugins/ruby-build \
    && ${RBENV_ROOT}/bin/rbenv install 3.3.10 \
    && ${RBENV_ROOT}/bin/rbenv global 3.3.10
ENV PATH="${RBENV_ROOT}/shims:${RBENV_ROOT}/bin:${PATH}"

# ─── Bundler and Fastlane ───
RUN gem install bundler fastlane --no-document

# ─── Android SDK command-line tools ───
ENV ANDROID_SDK_ROOT=/opt/android-sdk
RUN mkdir -p ${ANDROID_SDK_ROOT}/cmdline-tools \
    && curl -fsSL https://dl.google.com/android/repository/commandlinetools-linux-14742923_latest.zip \
    -o /tmp/cmdline-tools.zip \
    && unzip -q /tmp/cmdline-tools.zip -d ${ANDROID_SDK_ROOT}/cmdline-tools \
    && mv ${ANDROID_SDK_ROOT}/cmdline-tools/cmdline-tools ${ANDROID_SDK_ROOT}/cmdline-tools/latest \
    && rm /tmp/cmdline-tools.zip
ENV PATH="${ANDROID_SDK_ROOT}/cmdline-tools/latest/bin:${ANDROID_SDK_ROOT}/platform-tools:${PATH}"

# Accept Android SDK licenses
RUN yes | sdkmanager --licenses 2>/dev/null || true

# ─── Runtime configuration defaults ───
ENV FASTLANE_LANE=build
ENV FASTLANE_PLATFORM=""
ENV BUNDLE_INSTALL=true

# Working directory for pipeline source
WORKDIR /app

# Default entrypoint — overridden by CodeBuildStep commands
CMD ["bash"]
