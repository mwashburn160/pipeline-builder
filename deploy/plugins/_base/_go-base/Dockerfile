# Pipeline Builder — Shared Go Base Image
#
# Build target tag: plugin-go-base:1.0
#
# One pinned Go, baked once, shared by every Go plugin (go-compile, go-test,
# golangci-lint, gosec, govulncheck, and the snyk/trivy/sonarcloud Go
# scanners). Replaces the per-plugin goenv installs. SINGLE-VERSION MODEL:
# bump GO_VERSION and rebuild to change — no runtime `goenv install`.

FROM plugin-base:26.10

USER root

RUN apt-retry-install build-essential

# Official Go binary tarball (no goenv), pinned version + per-arch SHA-256
# from https://go.dev/dl/?mode=json.
#
# 1.27.1 -> 1.27.2 (2026-10-10): 1.27.1's stdlib carries GO-2026-6612 and
# GO-2026-6604 (both Critical) plus eight Highs. Every Go plugin inherits this
# toolchain, so the finding was fleet-wide, not per-plugin — and it is the same
# toolchain bump the api/plugin and api/image-registry images needed.
#
# 1.27.2 -> 1.27.3: routine, taking the newest patch on the line. The three
# places Go is pinned move TOGETHER and are meant to stay equal — here, plus
# GO_IMAGE in api/plugin/Dockerfile and api/image-registry/Dockerfile. They are
# separate pins because one is a tarball and two are images, not because they
# may differ. 1.26.x is the other supported line if a 1.26 pin is ever
# wanted. GOPATH (module cache + `go install`
# target) is owned by the plugin user so builds and `go install` work non-root.
ARG GO_VERSION=1.27.3
ARG GO_SHA256_AMD64=65efbc80fdc1fa2cd2631cad5b481777a68e8725f34e89f50fc6ac714e379b40
ARG GO_SHA256_ARM64=a06e99309dbcbdca1a8ccd2282c3ee146e55930886e26b4f1193269587165f49
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
