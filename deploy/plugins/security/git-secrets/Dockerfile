# Git Secrets Plugin — Secret/Credential Detection
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# Combines Gitleaks + TruffleHog for comprehensive secret scanning
# Detects API keys, passwords, tokens, and other sensitive data in code

# ─── Tool versions (override with --build-arg) ───
ARG GITLEAKS_VERSION=8.30.1
# Gitleaks 8.30.1 also carries the fix for CVE-2026-63728 (Sprig template
# injection, CVSS 8.1), whose advisory has no earlier `fixed` event.
ARG TRUFFLEHOG_VERSION=3.99.8
# Gitleaks' own go.mod pins `golang.org/x/crypto v0.35.0` (indirect), which
# carries seven FIXABLE Criticals — so the published binary fails
# PLUGIN_VULN_GATE and this plugin could not be installed at all. 8.30.1 is
# upstream's LATEST release, so there is nothing to bump to and no waiver would
# be honest: the finding is real and a fix exists, just not upstream.
#
# So gitleaks is COMPILED HERE from its own tagged source with x/crypto raised
# to a pinned current release, instead of copying the published binary. This is
# the ordinary "rebuild with patched dependencies" remedy, and it is the only
# one available while upstream's newest release still requires the old module.
# Revisit when a gitleaks release ships a current x/crypto: this whole stage
# then collapses back to the one-line COPY it replaced.
ARG XCRYPTO_VERSION=0.58.0

FROM trufflesecurity/trufflehog:${TRUFFLEHOG_VERSION} AS trufflehog-src

# ─── Gitleaks, built from source with a patched x/crypto ───
# `go install pkg@version` would NOT work here: it resolves the module's own
# go.mod and ignores any replace/require override, so the vulnerable version
# would come straight back. Building from a checked-out tag is what lets the
# requirement be raised.
FROM plugin-go-base:1.0 AS gitleaks-src
ARG GITLEAKS_VERSION
ARG XCRYPTO_VERSION
USER root
# RETRIED for the same reason the `go install` plugins retry: the clone and the
# module fetches go through github.com and proxy.golang.org, both of which fail
# intermittently, and a cold catalogue load does this a hundred times over.
RUN set -eux; \
    for attempt in 1 2 3 4 5; do \
      rm -rf /src; \
      if git clone --depth 1 --branch "v${GITLEAKS_VERSION}" https://github.com/gitleaks/gitleaks.git /src; then break; fi; \
      echo "gitleaks clone failed (attempt $attempt/5); retrying" >&2; \
      sleep $((attempt * 5)); \
    done; \
    test -d /src/.git
RUN set -eux; \
    cd /src; \
    mkdir -p /out; \
    for attempt in 1 2 3 4 5; do \
      if go get "golang.org/x/crypto@v${XCRYPTO_VERSION}" \
        && CGO_ENABLED=0 go build -trimpath -ldflags "-s -w" -o /out/gitleaks .; then \
        break; \
      fi; \
      echo "gitleaks build failed (attempt $attempt/5); retrying" >&2; \
      sleep $((attempt * 5)); \
    done; \
    test -x /out/gitleaks; \
    # Fail the BUILD if the patch did not take, rather than shipping an image
    # that merely looks fixed: the whole point of this stage is the module
    # version baked into the binary, and `go get` can be silently overridden by
    # a transitive requirement.
    go version -m /out/gitleaks | grep -qE "golang.org/x/crypto[[:space:]]+v${XCRYPTO_VERSION}\$" \
      || { echo "x/crypto was not raised to v${XCRYPTO_VERSION} in the built binary" >&2; \
           go version -m /out/gitleaks | grep "x/crypto" >&2; exit 1; }

FROM plugin-base:26.10

# Build steps below need root (apt, writes under /usr/local, /opt or /etc);
# the image drops back to the unprivileged `plugin` user (uid 1000) at the end.
USER root

ARG GITLEAKS_VERSION
ARG TRUFFLEHOG_VERSION

# ─── Gitleaks — secret detection (built above, patched x/crypto) ───
COPY --from=gitleaks-src /out/gitleaks /usr/local/bin/gitleaks
RUN chmod 0755 /usr/local/bin/gitleaks

# ─── TruffleHog — credential scanner (copied from official image) ───
RUN mkdir -p /opt/trufflehog/versions
COPY --from=trufflehog-src /usr/bin/trufflehog /opt/trufflehog/versions/trufflehog-${TRUFFLEHOG_VERSION}
RUN ln -sf /opt/trufflehog/versions/trufflehog-${TRUFFLEHOG_VERSION} /usr/local/bin/trufflehog

# ─── Runtime configuration defaults ───
ENV GITLEAKS_VERSION=${GITLEAKS_VERSION}
ENV SCAN_MODE=directory
ENV GITLEAKS_CONFIG=""
ENV REPORT_FORMAT=json

# Working directory for pipeline source
WORKDIR /app
USER 1000:1000

# Default entrypoint — overridden by CodeBuildStep commands
CMD ["bash"]
