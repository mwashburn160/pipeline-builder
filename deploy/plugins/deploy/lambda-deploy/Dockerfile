# Lambda Deploy Plugin — AWS Lambda Function Deployment
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# Updates Lambda function code with zip or container image packaging

FROM pipeline-aws-cli-base:1.0

# ─── Runtime configuration defaults ───
ENV LAMBDA_FUNCTION=""
ENV LAMBDA_PACKAGE_TYPE=zip
ENV LAMBDA_SOURCE_DIR=.
ENV LAMBDA_HANDLER=""
ENV LAMBDA_ALIAS=""
ENV LAMBDA_PUBLISH=false

# Working directory for pipeline source
WORKDIR /app

# Default entrypoint — overridden by CodeBuildStep commands
CMD ["bash"]
