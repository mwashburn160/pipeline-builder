# govulncheck Plugin — Go Vulnerability Checker
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
#
# Thin layer over pipeline-go-base (one pinned Go, shared by all Go plugins).
# govulncheck is pinned + baked at build time — no runtime `go install`
# (deterministic, no network dependency at pipeline time).

FROM pipeline-go-base:1.0

# TODO(confirm): confirm the intended pinned govulncheck version at build time.
ARG GOVULNCHECK_VERSION=1.1.4
RUN go install "golang.org/x/vuln/cmd/govulncheck@v${GOVULNCHECK_VERSION}"

WORKDIR /app
CMD ["bash"]
