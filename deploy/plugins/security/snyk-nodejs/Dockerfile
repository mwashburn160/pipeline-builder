# Snyk Security Plugin — Node.js scanning
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
#
# Inherits from the snyk family base image (pipeline-snyk-base:1.0)
# which provides snyk CLI + (where applicable) Node.js. This file
# only adds the Node.js toolchain.

FROM pipeline-snyk-base:1.0

ENV NODE_VERSION=24

WORKDIR /app
CMD ["bash"]
