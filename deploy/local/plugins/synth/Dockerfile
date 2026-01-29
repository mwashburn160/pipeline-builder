ARG NODE_VERSION=24.9.0
ARG CDK_VERSION=2.233.0
ARG LIB_VERSION=0.1.24
FROM node:${NODE_VERSION}-alpine AS node
RUN apk update && \
    apk add --no-cache aws-cli curl unzip

WORKDIR /app
RUN npm install -g aws-cdk@${CDK_VERSION} && \
    npm install -g aws-cdk-lib@${LIB_VERSION}
RUN echo "AWS VERSION: $(aws --version)" && \
    echo "CDK VERSION: $(cdk --version)"