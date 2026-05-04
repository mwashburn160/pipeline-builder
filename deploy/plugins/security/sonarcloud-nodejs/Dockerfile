# SonarCloud Security Plugin — Node.js scanning
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
#
# Inherits from the sonarcloud family base image (pipeline-sonarcloud-base:1.0)
# which provides sonarcloud CLI + (where applicable) Node.js. This file
# only adds the Node.js toolchain.

FROM pipeline-sonarcloud-base:1.0

ENV NODE_VERSION=24

WORKDIR /app
CMD ["bash"]
