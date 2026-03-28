# ghcr-push

Push container images to GitHub Container Registry (ghcr.io) with GitHub CLI authentication using AWS CDK CodeBuildStep

**Version:** 1.0.0  
**Category:** artifact  
**Plugin Type:** CodeBuildStep  
**Compute:** MEDIUM  
**Timeout:** 15 minutes  
**Failure Behavior:** fail  

## Keywords

`container`, `docker`, `github`, `registry`

## Requirements

- Docker (for container image builds)
- 1 required secret(s) configured in AWS Secrets Manager (see [Secrets](#secrets) below)

## Secrets

| Name | Required | Description |
|------|----------|-------------|
| `GITHUB_TOKEN` | Yes | GitHub personal access token |

### Setting Up Secrets

Secrets are injected at build time via AWS CodeBuild environment variables backed by AWS Secrets Manager.

**Step 1: Store secrets in AWS Secrets Manager**

```bash
aws secretsmanager create-secret --name "GITHUB_TOKEN" --secret-string "<your-value>"
```

**Step 2: Reference secrets in your pipeline configuration**

When configuring this plugin in your pipeline, map each secret to the corresponding AWS Secrets Manager ARN:

```json
{
  "secrets": {
    "GITHUB_TOKEN": "arn:aws:secretsmanager:<region>:<account>:secret:GITHUB_TOKEN"
  }
}
```

**Step 3: IAM permissions**

Ensure the CodeBuild service role has `secretsmanager:GetSecretValue` permission for the referenced secrets.

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `GITHUB_USERNAME` | _none_ | GitHub username for registry authentication |
| `GITHUB_OWNER` | _none_ | GitHub owner (organization or username) for image namespace |
| `IMAGE_NAME` | _none_ | Name for the container image |
| `IMAGE_TAG` | `latest` | Tag for the container image |
| `DOCKERFILE_PATH` | `Dockerfile` | Path to the Dockerfile |
| `DOCKER_CONTEXT` | `.` | Docker build context directory |

## Output

Primary output directory: `registry-output`

## Usage

This plugin runs as an AWS CDK `CodeBuildStep` within the Pipeline Builder platform. Add it as a step in your pipeline configuration:

```json
{
  "name": "ghcr-push",
  "plugin": "ghcr-push",
  "env": {
    "GITHUB_USERNAME": "<your-github_username>",
    "GITHUB_OWNER": "<your-github_owner>",
    "IMAGE_NAME": "<your-image_name>",
    "IMAGE_TAG": "latest",
    "DOCKERFILE_PATH": "Dockerfile",
    "DOCKER_CONTEXT": "."
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
