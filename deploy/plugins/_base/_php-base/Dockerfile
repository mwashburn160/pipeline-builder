# Pipeline Builder — Shared PHP Base Image
#
# Build target tag: pipeline-php-base:1.0
#
# One pinned PHP (via deb.sury.org) + Composer, baked once, shared by every
# PHP plugin. SINGLE-VERSION MODEL: bump PHP_VERSION and rebuild.

FROM pipeline-plugin-base:24.04

RUN apt-retry-install software-properties-common

# Single PHP from packages.sury.org (Ondřej Surý's repo — has 8.4 for noble).
ARG PHP_VERSION=8.4
RUN set -eux; \
    install -d -m 0755 /etc/apt/keyrings; \
    for i in 1 2 3 4 5; do \
      curl -fsSL --retry 3 https://packages.sury.org/php/apt.gpg -o /etc/apt/keyrings/sury-php.gpg && break \
        || { echo "key fetch attempt $i failed, retrying"; sleep $((i * 5)); }; \
    done; \
    test -s /etc/apt/keyrings/sury-php.gpg; chmod 0644 /etc/apt/keyrings/sury-php.gpg; \
    UBUNTU_CODENAME=$(. /etc/os-release && echo "${UBUNTU_CODENAME}"); \
    echo "deb [signed-by=/etc/apt/keyrings/sury-php.gpg] https://packages.sury.org/php/ ${UBUNTU_CODENAME} main" \
      > /etc/apt/sources.list.d/sury-php.list

RUN apt-retry-install \
    php${PHP_VERSION} php${PHP_VERSION}-cli php${PHP_VERSION}-common php${PHP_VERSION}-mbstring php${PHP_VERSION}-xml \
    php${PHP_VERSION}-curl php${PHP_VERSION}-zip php${PHP_VERSION}-mysql php${PHP_VERSION}-pgsql php${PHP_VERSION}-sqlite3 \
    php${PHP_VERSION}-gd php${PHP_VERSION}-intl php${PHP_VERSION}-bcmath php${PHP_VERSION}-dev \
    && update-alternatives --set php /usr/bin/php${PHP_VERSION}

# Composer (pinned installer signature check is a follow-up hardening item).
RUN curl -fsSL https://getcomposer.org/installer | php -- --install-dir=/usr/local/bin --filename=composer

ENV PHP_VERSION=${PHP_VERSION}

RUN php --version && composer --version

WORKDIR /app
CMD ["bash"]
