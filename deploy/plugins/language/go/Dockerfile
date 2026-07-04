# Go Plugin — build / test / vet a Go project
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
#
# Thin layer over pipeline-go-base (one pinned Go, shared by all Go plugins).
# Go 1.24.13 + GOPATH are baked into the base — no goenv, no runtime version
# install. This plugin adds no tool of its own; it drives `go` from the base.

FROM pipeline-go-base:1.0

WORKDIR /app
CMD ["bash"]
