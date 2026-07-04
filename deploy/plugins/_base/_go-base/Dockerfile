# Pipeline Builder — Shared Go Base Image
#
# Build target tag: pipeline-go-base:1.0
#
# One pinned Go, baked once, shared by every Go plugin (go-compile, go-test,
# golangci-lint, gosec, govulncheck, and the snyk/trivy/sonarcloud Go
# scanners). Replaces the per-plugin goenv installs. SINGLE-VERSION MODEL:
# bump GO_VERSION and rebuild to change — no runtime `goenv install`.

FROM pipeline-plugin-base:24.04

RUN apt-retry-install build-essential

# Official Go binary tarball (no goenv). Version is a build-arg knob.
ARG GO_VERSION=1.24.13
ENV GO_HOME=/opt/go-sdk
ENV GOPATH=/opt/go
RUN set -eux; \
    case "$(dpkg --print-architecture)" in \
      amd64) arch=amd64 ;; \
      arm64) arch=arm64 ;; \
      *) echo "unsupported architecture: $(dpkg --print-architecture)" >&2; exit 1 ;; \
    esac; \
    curl -fsSL "https://go.dev/dl/go${GO_VERSION}.linux-${arch}.tar.gz" -o /tmp/go.tar.gz; \
    mkdir -p "${GO_HOME}"; \
    tar -xzf /tmp/go.tar.gz -C "${GO_HOME}" --strip-components=1; \
    rm -f /tmp/go.tar.gz; \
    test -x "${GO_HOME}/bin/go"

ENV PATH="${GO_HOME}/bin:${GOPATH}/bin:${PATH}"
ENV GO_VERSION=${GO_VERSION}

RUN go version

WORKDIR /app
CMD ["bash"]
