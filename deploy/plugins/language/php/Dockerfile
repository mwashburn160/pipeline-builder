# PHP Plugin — Multi-version build environment
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# PHP version is selected at runtime via PHP_VERSION env var

FROM pipeline-plugin-base:24.04

RUN apt-retry-install software-properties-common

# ─── PHP via deb.sury.org ───
#
# We use packages.sury.org (Ondřej Surý's own repo) instead of the Launchpad
# PPA `ondrej/php`. Same maintainer, but the .org repo:
#   - Has faster + more complete coverage (PHP 8.4 for noble is here; the
#     Launchpad PPA was missing it)
#   - Is CDN-fronted, so no Launchpad-API 504s during key/index fetch
#   - Ships its own signing key over HTTPS, no keyserver dance required
#
# Steps are wrapped in retry loops so transient mirror flaps self-heal.
RUN set -eux; \
    install -d -m 0755 /etc/apt/keyrings; \
    for i in 1 2 3 4 5; do \
      curl -fsSL --retry 3 https://packages.sury.org/php/apt.gpg \
        -o /etc/apt/keyrings/sury-php.gpg && break \
        || { echo "key fetch attempt $i failed, retrying"; sleep $((i * 5)); }; \
    done; \
    test -s /etc/apt/keyrings/sury-php.gpg; \
    chmod 0644 /etc/apt/keyrings/sury-php.gpg; \
    UBUNTU_CODENAME=$(. /etc/os-release && echo "${UBUNTU_CODENAME}"); \
    echo "deb [signed-by=/etc/apt/keyrings/sury-php.gpg] https://packages.sury.org/php/ ${UBUNTU_CODENAME} main" \
      > /etc/apt/sources.list.d/sury-php.list; \
    for i in 1 2 3 4 5; do \
      apt-get update && break || { echo "apt-get update attempt $i failed, retrying"; sleep $((i * 5)); }; \
    done; \
    # Sanity-check that the repo actually contributed php8.4 packages.
    # Surfaces a missing version NOW with a clear error, instead of failing
    # 30s later on `apt-get install` with "Unable to locate package".
    apt-cache policy php8.4-cli | grep -q packages.sury.org \
      || { echo "ERROR: sury repo loaded but php8.4-cli not found for ${UBUNTU_CODENAME}"; \
           apt-cache policy php8.4-cli; exit 1; }

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
