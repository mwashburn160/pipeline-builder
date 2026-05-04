# ECS Deploy Plugin — Amazon ECS Service Deployment
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# Updates task definitions and services with rolling deployments

FROM pipeline-aws-cli-base:1.0

# ─── Runtime configuration defaults ───
ENV ECS_CLUSTER=""
ENV ECS_SERVICE=""
ENV IMAGE_URI=""
ENV ECS_TASK_FAMILY=""
ENV ECS_WAIT=true

# Working directory for pipeline source
WORKDIR /app

# Default entrypoint — overridden by CodeBuildStep commands
CMD ["bash"]
