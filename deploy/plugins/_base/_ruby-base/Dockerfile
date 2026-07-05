# Pipeline Builder — Shared Ruby Base Image
#
# Build target tag: pipeline-ruby-base:1.0
#
# One pinned Ruby, baked once, shared by every Ruby plugin (rails-test,
# minitest-coverage, rubocop, brakeman, bundler-audit, and the snyk/sonarcloud
# Ruby scanners). SINGLE-VERSION MODEL: bump RUBY_VERSION and rebuild.
#
# Why COPY /usr/local from the official ruby image (not the ruby/ruby-builder
# tarball): the ruby-builder tarballs hardcode their build-time prefix in the
# `gem`/`bundle` wrapper shebangs AND in the RubyGems stdlib path, so relocating
# them breaks `gem` ("cannot execute: required file not found" / "cannot load
# rubygems/gem_runner"). The official image installs Ruby under /usr/local (its
# real prefix); copying it to the SAME /usr/local prefix means NO relocation —
# shebangs and the stdlib path resolve exactly as built. We keep FROM
# pipeline-plugin-base so `run-logged` + `apt-retry-install` are still inherited.

# Global ARG (declared before the first FROM) so it can parameterize the
# ruby-src stage's image tag — an ARG can't be interpolated in `COPY --from=`
# directly, hence the named-stage pattern.
ARG RUBY_VERSION=4.0.5
FROM ruby:${RUBY_VERSION} AS ruby-src

FROM pipeline-plugin-base:24.04

# Shared libs the copied Ruby links against + headers for native gem extensions
# built at pipeline runtime (nokogiri et al.).
RUN apt-retry-install \
    libssl3 libyaml-0-2 zlib1g libffi8 libgmp10 libreadline8 \
    build-essential libssl-dev zlib1g-dev libyaml-dev libffi-dev libreadline-dev

# Copy a fully-working Ruby from the official image. Same prefix (/usr/local) →
# no relocation. (Debian-built binary runs on this Ubuntu base: glibc is
# forward-compatible and the runtime libs above are provided.)
COPY --from=ruby-src /usr/local/ /usr/local/

# A stable GEM_HOME on PATH so a plugin's `gem install <tool>` lands on PATH.
ENV GEM_HOME=/opt/gems
ENV PATH="${GEM_HOME}/bin:/usr/local/bin:${PATH}"
# Re-declare the ARG in this stage to surface it as a runtime env knob.
ARG RUBY_VERSION
ENV RUBY_VERSION=${RUBY_VERSION}

RUN ldconfig && ruby --version && gem --version && bundle --version

WORKDIR /app
CMD ["bash"]
