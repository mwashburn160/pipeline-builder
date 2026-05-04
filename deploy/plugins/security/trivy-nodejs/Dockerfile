# Trivy Security Plugin — Node.js scanning
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
#
# Inherits from the trivy family base image (pipeline-trivy-base:1.0)
# which provides trivy CLI + (where applicable) Node.js. This file
# only adds the Node.js toolchain.

FROM pipeline-trivy-base:1.0

ENV NODE_VERSION=24

WORKDIR /app
CMD ["bash"]
