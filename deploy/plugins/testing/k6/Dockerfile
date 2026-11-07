# k6 Plugin — Performance and Load Testing
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# Runs k6 load tests with configurable VUs, duration, and thresholds
# Multi-version support

# ─── Tool versions (override with --build-arg) ───
ARG K6_VERSION=2.3.0
# k6's published image carries three FIXABLE findings that failed
# PLUGIN_VULN_GATE, so this plugin could not be installed at all:
#
#   github.com/andybalholm/brotli v1.2.3  -> GO-2026-6888, Critical and
#       KEV-listed (CVE-2026-111497), fixed in 1.2.7.
#   golang.org/x/net v0.58.0              -> SEVEN advisories. Five are fixed in
#       0.60.0 (GO-2026-6603, -6610, -6611, -6612, -6617) and two only in 0.62.0
#       (GO-2026-6860, -6866), so 0.62.0 is the raise that clears all of them.
#   golang.org/x/crypto v0.56.0           -> rides along: x/net 0.62.0 requires
#       crypto 0.58.0 and text 0.43.0, so those are COMPANIONS, not remedies.
#
# A waiver would not have been honest here. The findings are real, fixes exist,
# and the only reason the published binary carries them is that upstream has not
# rebuilt — so k6 is COMPILED HERE from its own tagged source with the four
# modules raised, exactly as `security/git-secrets` does for gitleaks. Revisit
# when a k6 release ships current modules: this stage then collapses back to the
# one-line COPY it replaced.
#
# The module path carries the major version (`go.k6.io/k6/v2`), which is what Go
# requires at v2 and up — `go.k6.io/k6` alone stops at v1.8.2 and would silently
# build a two-year-old k6.
ARG BROTLI_VERSION=1.2.8
ARG XNET_VERSION=0.62.0
ARG XCRYPTO_VERSION=0.58.0
ARG XTEXT_VERSION=0.43.0

# ─── k6, built from source with the vulnerable modules raised ───
# `-mod=mod`: k6 commits a vendor/ tree, so once `go get` raises a requirement
# the default vendor mode refuses with "inconsistent vendoring" — on EVERY
# attempt, which is how this stage failed before it ever produced a binary.
# Building from the module cache uses exactly the raised go.mod.
# `go install go.k6.io/k6/v2@vX` would NOT work: it resolves the module's own
# go.mod and ignores any override, so the vulnerable versions come straight
# back. Building from a checked-out tag is what lets the requirements be raised.
FROM plugin-go-base:1.0 AS k6-src
ARG K6_VERSION
ARG BROTLI_VERSION
ARG XNET_VERSION
ARG XCRYPTO_VERSION
ARG XTEXT_VERSION
USER root
# RETRIED for the same reason the other source-built plugins retry: the clone
# and the module fetches go through github.com and proxy.golang.org, both of
# which fail intermittently, and a cold catalogue load does this a hundred times
# over.
RUN set -eux; \
    for attempt in 1 2 3 4 5; do \
      rm -rf /src; \
      if git clone --depth 1 --branch "v${K6_VERSION}" https://github.com/grafana/k6.git /src; then break; fi; \
      echo "k6 clone failed (attempt $attempt/5); retrying" >&2; \
      sleep $((attempt * 5)); \
    done; \
    test -d /src/.git
RUN set -eux; \
    cd /src; \
    mkdir -p /out; \
    for attempt in 1 2 3 4 5; do \
      if go get "github.com/andybalholm/brotli@v${BROTLI_VERSION}" \
          "golang.org/x/net@v${XNET_VERSION}" \
          "golang.org/x/crypto@v${XCRYPTO_VERSION}" \
          "golang.org/x/text@v${XTEXT_VERSION}" \
        && CGO_ENABLED=0 go build -mod=mod -trimpath -ldflags "-s -w" -o /out/k6 .; then \
        break; \
      fi; \
      echo "k6 build failed (attempt $attempt/5); retrying" >&2; \
      sleep $((attempt * 5)); \
    done; \
    test -x /out/k6
# Fail the BUILD if a raise did not take, rather than shipping an image that
# merely looks fixed: the point of this stage is the module versions baked into
# the binary, and `go get` can be overridden by a transitive requirement.
#
# Asserted as ">= the fix", NOT as "equal to the pin". MVS is allowed to resolve
# HIGHER than asked — another requirement in k6's graph can pull a module past
# the pin — and an equality check then fails a build whose patch actually
# succeeded. (`sort -V` orders the two; the lower one sorting first means baked
# >= wanted.)
RUN set -eux; \
    baked() { go version -m /out/k6 | awk -v m="$1" '$1 == "dep" && $2 == m { print $3 }'; }; \
    atleast() { \
      _m="$1"; _want="v$2"; _got="$(baked "$_m")"; \
      if [ -z "$_got" ]; then echo "$_m is not linked into the binary" >&2; return 1; fi; \
      if [ "$(printf '%s\n%s\n' "$_want" "$_got" | sort -V | head -1)" != "$_want" ]; then \
        echo "$_m is $_got, expected >= $_want" >&2; return 1; \
      fi; \
      echo "ok: $_m $_got (>= $_want)"; \
    }; \
    atleast github.com/andybalholm/brotli "${BROTLI_VERSION}"; \
    atleast golang.org/x/net "${XNET_VERSION}"; \
    atleast golang.org/x/crypto "${XCRYPTO_VERSION}"; \
    atleast golang.org/x/text "${XTEXT_VERSION}"

FROM plugin-base:26.10

# Build steps below need root (apt, writes under /usr/local, /opt or /etc);
# the image drops back to the unprivileged `plugin` user (uid 1000) at the end.
USER root

ARG K6_VERSION

# ─── k6 — built above, with the vulnerable modules raised ───
COPY --from=k6-src /out/k6 /usr/local/bin/k6
RUN chmod 0755 /usr/local/bin/k6

# ─── Runtime configuration defaults ───
ENV K6_VERSION=${K6_VERSION}
ENV K6_SCRIPT=""
ENV K6_VUS=10
ENV K6_DURATION=30s
ENV K6_THRESHOLDS=""

# Working directory for pipeline source
WORKDIR /app
USER 1000:1000

# Default entrypoint — overridden by CodeBuildStep commands
CMD ["bash"]
