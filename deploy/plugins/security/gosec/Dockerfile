# gosec Plugin — Go Security Checker
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
#
# Thin layer over pipeline-go-base (one pinned Go, shared by all Go plugins).
# gosec is pinned + baked at build time — no runtime `go install`
# (deterministic, no network dependency at pipeline time).

FROM pipeline-go-base:1.0

# TODO(confirm): confirm the intended pinned gosec version at build time.
ARG GOSEC_VERSION=2.21.4
RUN go install "github.com/securego/gosec/v2/cmd/gosec@v${GOSEC_VERSION}"

WORKDIR /app
CMD ["bash"]
