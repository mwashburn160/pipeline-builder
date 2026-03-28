# docker-build

Docker image build and push plugin supporting ECR, DockerHub, and custom registries with multi-stage builds and caching using AWS CDK CodeBuildStep

**Version:** 1.0.0  
**Category:** artifact  
**Plugin Type:** CodeBuildStep  
**Compute:** MEDIUM  
**Timeout:** 15 minutes  
**Failure Behavior:** fail  

## Keywords

`container`, `docker`, `build`, `multi-stage`

## Requirements

- AWS CLI configured with appropriate permissions
- 2 optional secret(s) for additional features (see [Secrets](#secrets) below)

## Secrets

| Name | Required | Description |
|------|----------|-------------|
| `DOCKER_USERNAME` | No | Docker registry username |
| `DOCKER_PASSWORD` | No | Docker registry password |

### Setting Up Secrets

Secrets are injected at build time via AWS CodeBuild environment variables backed by AWS Secrets Manager.

**Step 1: Store secrets in AWS Secrets Manager**

```bash
aws secretsmanager create-secret --name "DOCKER_USERNAME" --secret-string "<your-value>"
aws secretsmanager create-secret --name "DOCKER_PASSWORD" --secret-string "<your-value>"
```

**Step 2: Reference secrets in your pipeline configuration**

When configuring this plugin in your pipeline, map each secret to the corresponding AWS Secrets Manager ARN:

```json
{
  "secrets": {
    "DOCKER_USERNAME": "arn:aws:secretsmanager:<region>:<account>:secret:DOCKER_USERNAME",
    "DOCKER_PASSWORD": "arn:aws:secretsmanager:<region>:<account>:secret:DOCKER_PASSWORD"
  }
}
```

**Step 3: IAM permissions**

Ensure the CodeBuild service role has `secretsmanager:GetSecretValue` permission for the referenced secrets.

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `DOCKERFILE_PATH` | `Dockerfile` | Path to the Dockerfile |
| `DOCKER_CONTEXT` | `.` | Docker build context directory |
| `DOCKER_BUILD_ARGS` | _none_ | Space-separated build arguments (e.g., `KEY=VALUE`) |
| `DOCKER_TARGET` | _none_ | Target build stage for multi-stage builds |
| `DOCKER_CACHE_FROM` | _none_ | External cache source for the build |
| `REGISTRY_TYPE` | `ecr` | Registry type (`ecr`, `dockerhub`, `custom`, or `none`) |
| `IMAGE_NAME` | _none_ | Name for the container image |
| `IMAGE_TAG` | `latest` | Tag for the container image |

## Output

Primary output directory: `docker-output`

## Usage

This plugin runs as an AWS CDK `CodeBuildStep` within the Pipeline Builder platform. Add it as a step in your pipeline configuration:

```json
{
  "name": "docker-build",
  "plugin": "docker-build",
  "env": {
    "DOCKERFILE_PATH": "Dockerfile",
    "DOCKER_CONTEXT": ".",
    "DOCKER_BUILD_ARGS": "<your-docker_build_args>",
    "DOCKER_TARGET": "<your-docker_target>",
    "DOCKER_CACHE_FROM": "<your-docker_cache_from>",
    "REGISTRY_TYPE": "ecr",
    "IMAGE_NAME": "<your-image_name>",
    "IMAGE_TAG": "latest"
  }
}
```

## Files

| File | Description |
|------|-------------|
| `manifest.yaml` | Plugin configuration and build commands |
| `Dockerfile` | Container image definition |
| `plugin.zip` | Packaged plugin archive |
| `README.md` | This documentation file |
