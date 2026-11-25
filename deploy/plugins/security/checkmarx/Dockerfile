# Checkmarx Plugin — Enterprise SAST + KICS IaC Scanning
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# Supports Checkmarx One CLI and KICS for infrastructure-as-code
# Requires CX_CLIENT_SECRET at runtime

# ─── Tool versions (override with --build-arg) ───
ARG CX_CLI_VERSION=2.3.72
# The commit the ${CX_CLI_VERSION} tag must resolve to (checked after clone).
ARG CX_CLI_COMMIT=f4a4da11e850435c63b98a136fb6954d8cd449c9
# ast-cli's go.mod pins github.com/klauspost/compress v1.18.7 (indirect), which
# carries GO-2026-6865 (High, fixed in 1.20.2), and ${CX_CLI_VERSION} is
# upstream's latest release. So `cx` is compiled here from its tagged source
# with compress raised, instead of unpacking the release tarball — the same
# remedy as gitleaks (git-secrets) and dockle (docker-lint). Revisit when an
# ast-cli release ships compress >= 1.20.2: this stage then collapses back to
# the fetch-verified tarball download it replaced.
ARG COMPRESS_VERSION=1.20.5
ARG KICS_VERSION=2.2.1

FROM checkmarx/kics:v${KICS_VERSION} AS kics-src

# ─── Checkmarx One CLI, built from source with a patched compress ───
FROM plugin-go-base:1.0 AS cx-build
ARG CX_CLI_VERSION
ARG CX_CLI_COMMIT
ARG COMPRESS_VERSION
USER root
# RETRIED: the clone and module fetches go through github.com and
# proxy.golang.org, both of which fail intermittently.
RUN set -eux; \
    for attempt in 1 2 3 4 5; do \
      rm -rf /src; \
      if git clone --depth 1 --branch "${CX_CLI_VERSION}" https://github.com/Checkmarx/ast-cli.git /src; then break; fi; \
      echo "ast-cli clone failed (attempt $attempt/5); retrying" >&2; \
      sleep $((attempt * 5)); \
    done; \
    got="$(git -C /src rev-parse HEAD)"; \
    [ "$got" = "${CX_CLI_COMMIT}" ] || { echo "ast-cli ${CX_CLI_VERSION} resolved to $got, expected ${CX_CLI_COMMIT}" >&2; exit 1; }
RUN set -eux; \
    cd /src; \
    mkdir -p /out; \
    for attempt in 1 2 3 4 5; do \
      if go get "github.com/klauspost/compress@v${COMPRESS_VERSION}" \
        && CGO_ENABLED=0 go build -trimpath \
          -ldflags "-s -w -X github.com/checkmarx/ast-cli/internal/params.Version=${CX_CLI_VERSION}" \
          -o /out/cx ./cmd/main.go; then \
        break; \
      fi; \
      echo "ast-cli build failed (attempt $attempt/5); retrying" >&2; \
      sleep $((attempt * 5)); \
    done; \
    test -x /out/cx; \
    _got="$(go version -m /out/cx | awk '$1 == "dep" && $2 == "github.com/klauspost/compress" { print $3 }')"; \
    [ -n "$_got" ] || { echo "klauspost/compress is not linked into cx" >&2; exit 1; }; \
    [ "$(printf '%s\n%s\n' "v${COMPRESS_VERSION}" "$_got" | sort -V | head -1)" = "v${COMPRESS_VERSION}" ] \
      || { echo "klauspost/compress is $_got in cx, expected >= v${COMPRESS_VERSION}" >&2; exit 1; }; \
    /out/cx version

FROM plugin-base:26.10

# Writes under /usr/local need root; dropped to uid 1000 at the end.
USER root

# ─── Checkmarx One CLI (built above, patched compress) ───
COPY --from=cx-build /out/cx /usr/local/bin/cx
RUN chmod 0755 /usr/local/bin/cx && cx version

# ─── KICS (IaC Scanner by Checkmarx — copied from official image) ───
COPY --from=kics-src /app/bin/kics /usr/local/bin/kics
COPY --from=kics-src /app/bin/assets /opt/kics/assets
ENV KICS_QUERIES_PATH=/opt/kics/assets/queries

# Non-sensitive config only
ENV CX_BASE_URI=https://ast.checkmarx.net
ENV CX_TENANT=""
ENV CX_PROJECT_NAME=""
ENV CX_CLIENT_ID=""
ENV CX_SCAN_TYPE=sast
ENV CX_SEVERITY_THRESHOLD=high

WORKDIR /app
USER 1000:1000
CMD ["bash"]
