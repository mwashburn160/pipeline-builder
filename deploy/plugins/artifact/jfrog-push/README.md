# jfrog-push

Push container images to JFrog Artifactory Docker registry with JFrog CLI authentication using AWS CDK CodeBuildStep

**Version:** 1.0.0  
**Category:** artifact  
**Plugin Type:** CodeBuildStep  
**Compute:** MEDIUM  
**Timeout:** 15 minutes  
**Failure Behavior:** fail  

## Keywords

`container`, `docker`, `jfrog`, `artifactory`

## Requirements

- Docker (for container image builds)
- 1 required secret(s) configured in AWS Secrets Manager (see [Secrets](#secrets) below)

## Secrets

| Name | Required | Description |
|------|----------|-------------|
| `JFROG_TOKEN` | Yes | JFrog access token |

### Setting Up Secrets

Secrets are injected at build time via AWS CodeBuild environment variables backed by AWS Secrets Manager.

**Step 1: Store secrets in AWS Secrets Manager**

```bash
aws secretsmanager create-secret --name "JFROG_TOKEN" --secret-string "<your-value>"
```

**Step 2: Reference secrets in your pipeline configuration**

When configuring this plugin in your pipeline, map each secret to the corresponding AWS Secrets Manager ARN:

```json
{
  "secrets": {
    "JFROG_TOKEN": "arn:aws:secretsmanager:<region>:<account>:secret:JFROG_TOKEN"
  }
}
```

**Step 3: IAM permissions**

Ensure the CodeBuild service role has `secretsmanager:GetSecretValue` permission for the referenced secrets.

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `JFROG_URL` | _none_ | JFrog Artifactory URL |
| `JFROG_REPO` | _none_ | JFrog repository name |
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
  "name": "jfrog-push",
  "plugin": "jfrog-push",
  "env": {
    "JFROG_URL": "<your-jfrog_url>",
    "JFROG_REPO": "<your-jfrog_repo>",
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
| `plugin-spec.yaml` | Plugin configuration and build commands |
| `Dockerfile` | Container image definition |
| `plugin.zip` | Packaged plugin archive |
| `README.md` | This documentation file |
