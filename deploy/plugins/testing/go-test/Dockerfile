# Go Test Plugin — Test Runner
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
#
# Thin layer over pipeline-go-base (one pinned Go, shared by all Go plugins).
# go-junit-report is pinned + baked at build time — no runtime `go install`
# (deterministic, no network dependency at pipeline time).

FROM pipeline-go-base:1.0

# TODO(confirm): confirm the intended pinned go-junit-report version.
ARG GO_JUNIT_REPORT_VERSION=2.1.0
RUN go install "github.com/jstemmer/go-junit-report/v2@v${GO_JUNIT_REPORT_VERSION}"

WORKDIR /app
CMD ["bash"]
