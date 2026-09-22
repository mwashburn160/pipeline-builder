# Pipeline Builder — Shared Go Base Image
#
# Build target tag: pipeline-go-base:1.0
#
# One pinned Go, baked once, shared by every Go plugin (go-compile, go-test,
# golangci-lint, gosec, govulncheck, and the snyk/trivy/sonarcloud Go
# scanners). Replaces the per-plugin goenv installs. SINGLE-VERSION MODEL:
# bump GO_VERSION and rebuild to change — no runtime `goenv install`.

FROM pipeline-plugin-base:24.04

USER root

RUN apt-retry-install build-essential

# Official Go binary tarball (no goenv), pinned version + per-arch SHA-256
# from https://go.dev/dl/?mode=json. GOPATH (module cache + `go install`
# target) is owned by the plugin user so builds and `go install` work non-root.
ARG GO_VERSION=1.27.1
ARG GO_SHA256_AMD64=63d339f0da5ab53635a56f2490a7984dfe12dfcff22ad749f63edaf590168445
ARG GO_SHA256_ARM64=3450b45a3f9ee8568792736a5c5e70a1f2e9b36c35a8f74958c03e51d7d92bec
ENV GO_HOME=/opt/go-sdk
ENV GOPATH=/opt/go
RUN set -eux; \
    case "$(dpkg --print-architecture)" in \
      amd64) arch=amd64; sum="${GO_SHA256_AMD64}" ;; \
      arm64) arch=arm64; sum="${GO_SHA256_ARM64}" ;; \
      *) echo "unsupported architecture: $(dpkg --print-architecture)" >&2; exit 1 ;; \
    esac; \
    fetch-verified "https://go.dev/dl/go${GO_VERSION}.linux-${arch}.tar.gz" "$sum" /tmp/go.tar.gz; \
    mkdir -p "${GO_HOME}"; \
    tar -xzf /tmp/go.tar.gz -C "${GO_HOME}" --strip-components=1; \
    rm -f /tmp/go.tar.gz; \
    test -x "${GO_HOME}/bin/go"; \
    install -d -o 1000 -g 1000 "${GOPATH}" "${GOPATH}/bin"

ENV PATH="${GO_HOME}/bin:${GOPATH}/bin:${PATH}"
ENV GO_VERSION=${GO_VERSION}

RUN go version

WORKDIR /app
USER 1000:1000
CMD ["bash"]
