# Pipeline Builder — Shared PHP Base Image
#
# Build target tag: pipeline-php-base:1.0
#
# One pinned PHP (via deb.sury.org) + Composer, baked once, shared by every
# PHP plugin. SINGLE-VERSION MODEL: bump PHP_VERSION and rebuild.

FROM pipeline-plugin-base:24.04

USER root

RUN apt-retry-install software-properties-common

# Single PHP from packages.sury.org (Ondřej Surý's repo — has 8.5 for noble).
# The repo signing key is pinned by fingerprint (fetch-apt-key).
ARG PHP_VERSION=8.5
RUN set -eux; \
    fetch-apt-key https://packages.sury.org/php/apt.gpg /etc/apt/keyrings/sury-php.gpg \
      15058500A0235D97F5D10063B188E2B695BD4743; \
    UBUNTU_CODENAME=$(. /etc/os-release && echo "${UBUNTU_CODENAME}"); \
    echo "deb [signed-by=/etc/apt/keyrings/sury-php.gpg] https://packages.sury.org/php/ ${UBUNTU_CODENAME} main" \
      > /etc/apt/sources.list.d/sury-php.list

RUN apt-retry-install \
    php${PHP_VERSION} php${PHP_VERSION}-cli php${PHP_VERSION}-common php${PHP_VERSION}-mbstring php${PHP_VERSION}-xml \
    php${PHP_VERSION}-curl php${PHP_VERSION}-zip php${PHP_VERSION}-mysql php${PHP_VERSION}-pgsql php${PHP_VERSION}-sqlite3 \
    php${PHP_VERSION}-gd php${PHP_VERSION}-intl php${PHP_VERSION}-bcmath php${PHP_VERSION}-dev \
    && update-alternatives --set php /usr/bin/php${PHP_VERSION}

# Composer: the pinned composer.phar release, verified against the
# .sha256sum getcomposer.org publishes beside it (no `curl | php` installer).
ARG COMPOSER_VERSION=2.10.3
ARG COMPOSER_SHA256=7a2d379d5b8ffdaa028580ef26494c36d2feef4b178d3dd1473a4dbc5e17c8d6
RUN fetch-verified "https://getcomposer.org/download/${COMPOSER_VERSION}/composer.phar" "${COMPOSER_SHA256}" /usr/local/bin/composer \
    && chmod 0755 /usr/local/bin/composer

ENV PHP_VERSION=${PHP_VERSION}

RUN php --version && composer --version

WORKDIR /app
USER 1000:1000
CMD ["bash"]
