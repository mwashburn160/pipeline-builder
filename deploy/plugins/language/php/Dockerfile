# PHP Plugin — Multi-version build environment
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# PHP version is selected at runtime via PHP_VERSION env var

FROM public.ecr.aws/docker/library/ubuntu:24.04

# Avoid interactive prompts
ENV DEBIAN_FRONTEND=noninteractive

# System dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    zip \
    unzip \
    curl \
    jq \
    ca-certificates \
    gnupg \
    software-properties-common \
    && rm -rf /var/lib/apt/lists/*

# ─── PHP via ondrej/php PPA ───
RUN add-apt-repository ppa:ondrej/php -y && apt-get update

# Pre-install PHP 8.3 (previous)
RUN apt-get install -y --no-install-recommends \
    php8.3 php8.3-cli php8.3-common php8.3-mbstring php8.3-xml \
    php8.3-curl php8.3-zip php8.3-mysql php8.3-pgsql php8.3-sqlite3 \
    php8.3-gd php8.3-intl php8.3-bcmath php8.3-dev \
    && rm -rf /var/lib/apt/lists/*

# Pre-install PHP 8.4 (current)
RUN apt-get update && apt-get install -y --no-install-recommends \
    php8.4 php8.4-cli php8.4-common php8.4-mbstring php8.4-xml \
    php8.4-curl php8.4-zip php8.4-mysql php8.4-pgsql php8.4-sqlite3 \
    php8.4-gd php8.4-intl php8.4-bcmath php8.4-dev \
    && rm -rf /var/lib/apt/lists/*

# Default to PHP 8.4
RUN update-alternatives --set php /usr/bin/php8.4

# ─── Composer (global install) ───
RUN curl -fsSL https://getcomposer.org/installer | php -- --install-dir=/usr/local/bin --filename=composer

# Default PHP version
ENV PHP_VERSION=8.4

# Working directory for pipeline source
WORKDIR /app

# Default entrypoint — overridden by CodeBuildStep commands
CMD ["bash"]
