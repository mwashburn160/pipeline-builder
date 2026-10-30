# Pipeline Builder — Shared PHP Base Image
#
# Build target tag: plugin-php-base:1.0
#
# One pinned PHP + Composer, baked once, shared by every PHP plugin.
# SINGLE-VERSION MODEL: bump PHP_VERSION and rebuild.
#
# THE SURY REPO IS GONE, and the base move to Ubuntu 26.10 is why. sury
# (packages.sury.org/php) existed here because noble's archive had no PHP 8.5,
# and it publishes per-codename: its dists are bookworm, bullseye, jammy,
# noble, resolute and trixie — `stonking` (26.10) 404s, so carrying it forward
# was not an option anyway. 26.10 ships php8.5 8.5.9 in its own archive, and
# all fourteen packages below resolve from it, so the third-party key, repo
# file and `software-properties-common` are all deleted rather than ported.
# That removes a signing key and an external archive from the trust path of
# every PHP plugin image.
#
# If this base ever moves back to an LTS whose archive predates the PHP
# version wanted here, sury comes back — it is not deprecated, just unneeded.

FROM plugin-base:26.10

USER root

ARG PHP_VERSION=8.5
RUN apt-retry-install \
    php${PHP_VERSION} php${PHP_VERSION}-cli php${PHP_VERSION}-common php${PHP_VERSION}-mbstring php${PHP_VERSION}-xml \
    php${PHP_VERSION}-curl php${PHP_VERSION}-zip php${PHP_VERSION}-mysql php${PHP_VERSION}-pgsql php${PHP_VERSION}-sqlite3 \
    php${PHP_VERSION}-gd php${PHP_VERSION}-intl php${PHP_VERSION}-bcmath php${PHP_VERSION}-dev \
    && update-alternatives --set php /usr/bin/php${PHP_VERSION}

# Composer: the pinned composer.phar release, verified against the
# .sha256sum getcomposer.org publishes beside it (no `curl | php` installer).
ARG COMPOSER_VERSION=2.11.0
ARG COMPOSER_SHA256=9674f12a2a181100d889ebfd0b4510805b3e94cea57869b14b383753d602599b
RUN fetch-verified "https://getcomposer.org/download/${COMPOSER_VERSION}/composer.phar" "${COMPOSER_SHA256}" /usr/local/bin/composer \
    && chmod 0755 /usr/local/bin/composer

ENV PHP_VERSION=${PHP_VERSION}

RUN php --version && composer --version

WORKDIR /app
USER 1000:1000
CMD ["bash"]
