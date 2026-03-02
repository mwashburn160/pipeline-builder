# License Checker Plugin — OSS License Compliance Scanning
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# Scans project dependencies for license compatibility issues
# Supports Node.js, Python, Java, Go, Ruby, .NET, Rust

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
    python3 \
    python3-pip \
    && rm -rf /var/lib/apt/lists/*

# ─── Node.js (for license-checker npm package) ───
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# ─── License scanning tools ───
# Node.js: license-checker
RUN npm install -g license-checker@25.0.1

# Python: pip-licenses
RUN pip3 install --no-cache-dir --break-system-packages pip-licenses==5.0.0

# Go: go-licenses (installed at runtime if needed)
# Ruby: license_finder
RUN apt-get update && apt-get install -y --no-install-recommends ruby ruby-dev \
    && gem install license_finder --no-document \
    && rm -rf /var/lib/apt/lists/*

# ─── Runtime configuration defaults ───
ENV LICENSE_DENY=""
ENV LICENSE_ALLOW=""
ENV REPORT_FORMAT=json

# Working directory for pipeline source
WORKDIR /app

# Default entrypoint — overridden by CodeBuildStep commands
CMD ["bash"]
