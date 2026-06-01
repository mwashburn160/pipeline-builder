# Ruby Plugin — Multi-version build environment using rbenv
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# Ruby version is selected at runtime via RUBY_VERSION env var

FROM pipeline-plugin-base:24.04

# System dependencies. The build toolchain (build-essential + headers) is
# kept because user pipelines still compile native gem extensions (nokogiri
# et al.) at runtime — only the Ruby runtimes themselves are now precompiled.
# curl + ca-certificates are needed to fetch the prebuilt Ruby tarballs.
RUN apt-retry-install build-essential libssl-dev zlib1g-dev libreadline-dev libyaml-dev libffi-dev ca-certificates curl

# Install rbenv + ruby-build
ENV RBENV_ROOT=/opt/rbenv
RUN git clone https://github.com/rbenv/rbenv.git ${RBENV_ROOT} \
    && git clone https://github.com/rbenv/ruby-build.git ${RBENV_ROOT}/plugins/ruby-build

# Pre-install current + previous Ruby versions as PRECOMPILED builds from
# ruby/ruby-builder (built for this image's ubuntu-24.04 base), unpacked
# straight into rbenv's versions/ dir. This replaces compiling each Ruby from
# source via `rbenv install`, which was the dominant build cost and exceeded
# the build timeout on the CPU-constrained buildkit sidecar.
#
# The `test -x .../bin/ruby` and final `ruby --version` guards make the build
# self-validating: if a tarball is missing for a version, the layout differs,
# or a build isn't relocatable to this path, the build fails loudly here
# instead of producing a broken image.
# ruby/ruby-builder publishes one release per version, with per-arch assets:
#   .../releases/download/ruby-<v>/ruby-<v>-ubuntu-24.04-<x64|arm64>.tar.gz
# Each tarball has a single top-level dir named for the arch (e.g. `x64/`),
# so --strip-components=1 drops it and lands bin/ + lib/ in the dest. The
# binaries link libruby.so.* without an $ORIGIN-relative rpath, so each
# version's lib/ is registered with the dynamic linker via ld.so.conf.d +
# ldconfig (distinct sonames per version — libruby.so.3.4 vs .4.0 — so no
# clash); the `ruby --version` guard below confirms it resolves on this base.
ARG RUBY_VERSIONS="3.4.8 4.0.1"
ARG RUBY_BUILDER_BASE="https://github.com/ruby/ruby-builder/releases/download"
RUN set -eux; \
    case "$(dpkg --print-architecture)" in \
      amd64) arch=x64 ;; \
      arm64) arch=arm64 ;; \
      *) echo "unsupported architecture: $(dpkg --print-architecture)" >&2; exit 1 ;; \
    esac; \
    for v in ${RUBY_VERSIONS}; do \
      dest="${RBENV_ROOT}/versions/${v}"; \
      mkdir -p "${dest}"; \
      curl -fsSL "${RUBY_BUILDER_BASE}/ruby-${v}/ruby-${v}-ubuntu-24.04-${arch}.tar.gz" -o /tmp/ruby.tar.gz; \
      tar -xzf /tmp/ruby.tar.gz -C "${dest}" --strip-components=1; \
      rm -f /tmp/ruby.tar.gz; \
      test -x "${dest}/bin/ruby"; \
      echo "${dest}/lib" >> /etc/ld.so.conf.d/rbenv-rubies.conf; \
    done; \
    ldconfig; \
    "${RBENV_ROOT}/bin/rbenv" global 4.0.1; \
    "${RBENV_ROOT}/bin/rbenv" rehash

# Add rbenv to PATH
ENV PATH="${RBENV_ROOT}/shims:${RBENV_ROOT}/bin:${PATH}"

# Validate the precompiled runtimes resolve through the shims (fails the build
# if a prebuilt isn't runnable on this base — e.g. a missing shared lib).
RUN ruby --version && rbenv versions

# Default Ruby version (overridden by RUBY_VERSION env var at runtime)
ENV RUBY_VERSION=4.0.1

# Working directory for pipeline source
WORKDIR /app

# Default entrypoint — overridden by CodeBuildStep commands
CMD ["bash"]
