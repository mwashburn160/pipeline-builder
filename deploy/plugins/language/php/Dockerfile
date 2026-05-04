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
#
# `add-apt-repository ppa:ondrej/php` calls Launchpad's API to fetch the
# signing key, which intermittently 504s under load and aborts the whole
# build. We bypass it by:
#   1. Fetching the PPA's signing key directly (retried, multiple keyservers)
#   2. Writing the apt source list ourselves
#   3. Retrying `apt-get update` since archive mirrors can also flap
#
# Effective build is identical to `add-apt-repository ppa:ondrej/php` but
# resilient to single-mirror failures.
RUN set -eux; \
    KEY_ID=4F4EA0AAE5267A6C; \
    install -d -m 0755 /etc/apt/keyrings; \
    for keyserver in \
        keyserver.ubuntu.com \
        keys.openpgp.org \
        pgp.mit.edu; do \
      if gpg --keyserver "hkps://${keyserver}" --no-default-keyring \
             --keyring /etc/apt/keyrings/ondrej-php.gpg --recv-keys "${KEY_ID}"; then \
        echo "fetched PPA key from ${keyserver}"; \
        break; \
      fi; \
      echo "keyserver ${keyserver} failed, trying next"; \
      sleep 5; \
    done; \
    test -s /etc/apt/keyrings/ondrej-php.gpg; \
    UBUNTU_CODENAME=$(. /etc/os-release && echo "${UBUNTU_CODENAME}"); \
    echo "deb [signed-by=/etc/apt/keyrings/ondrej-php.gpg] http://ppa.launchpad.net/ondrej/php/ubuntu ${UBUNTU_CODENAME} main" \
      > /etc/apt/sources.list.d/ondrej-php.list; \
    for i in 1 2 3 4 5; do \
      apt-get update && break || { echo "apt-get update attempt $i failed, retrying"; sleep $((i * 5)); }; \
    done

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
