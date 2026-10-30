# gosec Plugin — Go Security Checker
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
#
# Thin layer over plugin-go-base (one pinned Go, shared by all Go plugins).
# gosec is pinned + baked at build time — no runtime `go install`
# (deterministic, no network dependency at pipeline time).

FROM plugin-go-base:1.0

ARG GOSEC_VERSION=2.30.0
# RETRIED: `go install` fetches through proxy.golang.org, which intermittently
# aborts a download mid-stream ("stream error: ...; INTERNAL_ERROR; received
# from peer") and fails the layer although the pin is correct. GOPROXY's
# `,direct` fallback does not cover it — Go advances to the next entry only on
# 404/410, never on a transport error.
RUN set -eux; \
    for attempt in 1 2 3 4 5; do \
      go install "github.com/securego/gosec/v2/cmd/gosec@v${GOSEC_VERSION}" && exit 0; \
      echo "go install gosec failed (attempt $attempt/5); retrying" >&2; \
      sleep $((attempt * 5)); \
    done; \
    echo "go install gosec failed after 5 attempts" >&2; exit 1

WORKDIR /app
USER 1000:1000
CMD ["bash"]
