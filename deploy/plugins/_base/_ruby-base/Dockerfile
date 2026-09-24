# Pipeline Builder — Shared Ruby Base Image
#
# Build target tag: pipeline-ruby-base:1.0
#
# One pinned Ruby, baked once, shared by every Ruby plugin (rails-test,
# minitest-coverage, rubocop, brakeman, bundler-audit, and the snyk/sonarcloud
# Ruby scanners). SINGLE-VERSION MODEL: bump RUBY_VERSION and rebuild.
#
# Why FROM the official ruby image (NOT `FROM pipeline-plugin-base` + COPY
# /usr/local from ruby): the official ruby image is Debian; pipeline-plugin-base
# is Ubuntu 24.04. Grafting Debian's Ruby onto Ubuntu breaks Ruby's `openssl`
# extension — it's linked against Debian's libssl, and Ubuntu 24.04's libssl3 is
# a different OpenSSL build, so `require "openssl"` fails at runtime with
# "OpenSSL is not available" and EVERY `gem install` (which fetches over HTTPS
# from rubygems.org) dies. `ruby`/`gem --version` don't load openssl, so the old
# base built green while being fundamentally broken. Starting FROM the official
# image keeps ruby/gem/bundle/openssl working exactly as built; we pull only the
# shared plugin helpers (run-logged, apt-retry-install) over from the plugin base.

ARG RUBY_VERSION=4.0.7
FROM ruby:${RUBY_VERSION}

# Shared plugin helpers (portable POSIX-sh scripts) so Ruby plugins get the same
# honest-gating (run-logged) + apt retry tooling as every other plugin. The ruby
# image is Debian, so apt-retry-install works here too.
COPY --from=pipeline-plugin-base:24.04 \
     /usr/local/bin/run-logged /usr/local/bin/apt-retry-install \
     /usr/local/bin/fetch-verified /usr/local/bin/fetch-apt-key /usr/local/bin/

# The same non-root `plugin` user (uid/gid 1000) as pipeline-plugin-base (the
# Debian ruby image has no uid-1000 user). A stable GEM_HOME on PATH, owned by
# that user, so a plugin's `gem install <tool>` / `bundle install` lands on
# PATH and works non-root. BUNDLE_APP_CONFIG (the official image points it at
# /usr/local/bundle) is handed over too so `bundle config` can write.
RUN set -eux; \
    groupadd --gid 1000 plugin; \
    useradd --uid 1000 --gid 1000 --create-home --home-dir /home/plugin --shell /bin/bash plugin; \
    install -d -o 1000 -g 1000 /opt/gems /app; \
    chown -R 1000:1000 /usr/local/bundle
ENV GEM_HOME=/opt/gems
ENV PATH="${GEM_HOME}/bin:${PATH}"
# Re-declare the ARG in this stage to surface it as a runtime env knob.
ARG RUBY_VERSION
ENV RUBY_VERSION=${RUBY_VERSION}

# Prove the toolchain works — INCLUDING the openssl extension. `gem --version`
# never loads openssl, so it can't catch a broken HTTPS stack; loading openssl
# explicitly here fails the BUILD if the extension can't load (the exact bug the
# old base shipped silently).
RUN ruby --version && gem --version && bundle --version \
    && ruby -ropenssl -e 'puts "openssl ok: #{OpenSSL::OPENSSL_VERSION}"'

WORKDIR /app
USER 1000:1000
CMD ["bash"]
