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

# ── Debian security updates ──
# Ubuntu-based plugin images don't need this: upstream rebuilds ubuntu:24.04
# continuously, so `FROM ...ubuntu:24.04` picks up Debian/Canonical security
# fixes on every build. The `ruby:X.Y.Z` tags are NOT rebuilt that way — a tag
# is cut when Ruby moves and then sits still, so a pinned Ruby drifts further
# behind Debian's security archive the longer it stays pinned. 4.0.7 ships
# libunbound8 and libheif-plugin-dav1d at versions Debian has already patched,
# which is what PLUGIN_VULN_GATE fails the Ruby plugins on.
#
# Fixing it here fixes it once: every Ruby plugin (rubocop, bundler-audit,
# minitest-coverage, snyk-ruby, brakeman, rails-test) inherits this layer.
#
# A whole-image upgrade rather than a list of packages, deliberately — naming
# packages means this layer only ever fixes the CVEs someone already saw, and
# the next one fails the gate again. The Ruby version stays pinned either way;
# `upgrade` never crosses a Debian release.
RUN set -eux; \
    apt-get update; \
    apt-get upgrade -y; \
    rm -rf /var/lib/apt/lists/*

# ── RubyGems / Bundler ──
# The ruby image pins RubyGems to whatever shipped with that Ruby — 4.0.7 gives
# 4.0.20. Nothing security-driven forces this: 4.0.21 and 4.0.22 carry no
# security section and OSV lists no advisory against 4.0.20. It is pinned
# current for the same reason every other tool here is, and so the version is a
# decision in this file rather than a side effect of the Ruby pin.
#
# Ordered BEFORE the json block below, not after: `gem update --system`
# reinstalls RubyGems' own default gems, so running it afterwards could put a
# default gemspec back on top of the replacement. The verification at the end of
# this file proves the final state either way.
ARG RUBYGEMS_VERSION=4.0.22
RUN set -eux; \
    gem update --system "$RUBYGEMS_VERSION" --no-document; \
    gem --version | grep -qx "$RUBYGEMS_VERSION"; \
    bundle --version

# ── Patched `json` default gem ──
# json is a DEFAULT gem: its code lives in the stdlib (rubylibdir + archdir),
# not in a gem directory, and 4.0.7 bundles 2.18.0 — CVE-2026-33210, fixed in
# 2.19.2. The pin below is 3.0.2, the current release, not the minimum that
# clears the CVE: plugin pins track latest. That is a MAJOR bump of a gem every
# other gem in the image loads, so the verification at the end of this file
# round-trips parse/generate under both plain ruby and `bundle exec` — a json
# that cannot load is a build failure here rather than a runtime failure in
# someone's pipeline. `gem update json` does NOT fix this. It installs a second copy that
# shadows the default for plain `ruby`, while `bundle exec` — which restricts
# the load path to the bundle plus DEFAULT gems — keeps loading the vulnerable
# stdlib copy. Verified in the image: under `bundle exec`, JSON::VERSION was
# still 2.18.0 from /usr/local/lib/ruby/4.0.0/json/common.rb. So the scanner is
# right and the obvious fix is not one.
#
# Replacing the default gem in place is: copy the patched gem's lib/ over
# rubylibdir and its compiled extension over archdir (the two layouts
# correspond exactly), then re-stamp the default gemspec, which is what both
# RubyGems and the SBOM read to decide what version is installed. Mutating the
# loaded spec and re-serialising it keeps require_paths and the file list
# intact; only the version moves.
#
# DELETE this block once the pinned ruby image ships this json — the
# `raise` below fires if the default gem is already at this version, so a stale
# block fails the build loudly instead of silently reinstalling what is there.
ARG JSON_GEM_VERSION=3.0.2
ENV JSON_GEM_VERSION=${JSON_GEM_VERSION}
RUN set -eux; \
    gem install json -v "$JSON_GEM_VERSION" --no-document; \
    ruby -e '\
      require "fileutils"; \
      v = ENV["JSON_GEM_VERSION"]; \
      spec = Gem::Specification.find_by_name(%q{json}, v); \
      specdir = Gem.default_specifications_dir; \
      old = Dir[File.join(specdir, %q{json-*.gemspec})]; \
      raise "expected one default json gemspec, found #{old.inspect}" unless old.size == 1; \
      default = Gem::Specification.load(old.first); \
      was = default.version.to_s; \
      raise "default json is already #{was} — drop this block" if was == v; \
      FileUtils.cp_r(Dir["#{spec.full_gem_path}/lib/."], RbConfig::CONFIG[%q{rubylibdir}], remove_destination: true); \
      FileUtils.cp_r(Dir["#{spec.extension_dir}/json/."], File.join(RbConfig::CONFIG[%q{archdir}], %q{json}), remove_destination: true); \
      default.version = Gem::Version.new(v); \
      File.write(File.join(specdir, "json-#{v}.gemspec"), default.to_ruby); \
      FileUtils.rm_f(old.first); \
      FileUtils.rm_rf(File.join(Gem.default_dir, %q{gems}, "json-#{was}")); \
    '

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
    && gem --version | grep -qx "$RUBYGEMS_VERSION" \
    && ruby -ropenssl -e 'puts "openssl ok: #{OpenSSL::OPENSSL_VERSION}"' \
    && ruby -rjson -e 'abort "json is #{JSON::VERSION}, expected #{ENV["JSON_GEM_VERSION"]}" unless JSON::VERSION == ENV["JSON_GEM_VERSION"]; puts "json ok: #{JSON::VERSION}"' \
    && (cd /tmp && printf "source \"https://rubygems.org\"\n" > Gemfile && bundle install --quiet \
        && bundle exec ruby -rjson -e 'abort "bundle-exec json is #{JSON::VERSION}" unless JSON::VERSION == ENV["JSON_GEM_VERSION"]; JSON.parse(JSON.generate({"ok" => [1, 2]})); puts "json ok under bundle exec"' \
        && rm -f Gemfile Gemfile.lock)

WORKDIR /app
USER 1000:1000
CMD ["bash"]
