# Go Plugin — build / test / vet a Go project
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
#
# Thin layer over plugin-go-base (one pinned Go, shared by all Go plugins).
# Go (pinned in plugin-go-base) + GOPATH are baked into the base — no goenv, no runtime version
# install. This plugin adds no tool of its own; it drives `go` from the base.

FROM plugin-go-base:1.0

WORKDIR /app
USER 1000:1000
CMD ["bash"]
