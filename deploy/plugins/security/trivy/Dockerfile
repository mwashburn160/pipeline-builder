# Trivy Security Plugin — language-agnostic filesystem + config scanning
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
#
# Inherits from the trivy family base image (pipeline-trivy-base:1.0),
# which is FROM aquasec/trivy and already provides the trivy CLI at
# /usr/local/bin/trivy (plus pinned versions under /opt/trivy/versions).
#
# `trivy fs` and `trivy config` scan lockfiles and IaC/config statically —
# they never build or execute user code — so NO language runtime is needed.

FROM pipeline-trivy-base:1.0

WORKDIR /app
CMD ["bash"]
