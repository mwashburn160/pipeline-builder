# gar-push

Push container images to Google Artifact Registry with gcloud service account authentication using AWS CDK CodeBuildStep

**Version:** 1.0.0  
**Category:** artifact  
**Plugin Type:** CodeBuildStep  
**Compute:** MEDIUM  
**Timeout:** 15 minutes  
**Failure Behavior:** fail  

## Keywords

`container`, `docker`, `gcp`, `registry`

## Requirements

- Docker (for container image builds)
- Google Cloud SDK (gcloud)
- 1 required secret(s) configured in AWS Secrets Manager (see [Secrets](#secrets) below)

## Secrets

| Name | Required | Description |
|------|----------|-------------|
| `GOOGLE_APPLICATION_CREDENTIALS` | Yes | Google Cloud service account credentials |

### Setting Up Secrets

Secrets are injected at build time via AWS CodeBuild environment variables backed by AWS Secrets Manager.

**Step 1: Store secrets in AWS Secrets Manager**

```bash
aws secretsmanager create-secret --name "GOOGLE_APPLICATION_CREDENTIALS" --secret-string "<your-value>"
```

**Step 2: Reference secrets in your pipeline configuration**

When configuring this plugin in your pipeline, map each secret to the corresponding AWS Secrets Manager ARN:

```json
{
  "secrets": {
    "GOOGLE_APPLICATION_CREDENTIALS": "arn:aws:secretsmanager:<region>:<account>:secret:GOOGLE_APPLICATION_CREDENTIALS"
  }
}
```

**Step 3: IAM permissions**

Ensure the CodeBuild service role has `secretsmanager:GetSecretValue` permission for the referenced secrets.

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `GAR_LOCATION` | `us-central1` | Google Artifact Registry location |
| `GAR_PROJECT` | _none_ | Google Cloud project ID |
| `GAR_REPOSITORY` | _none_ | Google Artifact Registry repository name |
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
  "name": "gar-push",
  "plugin": "gar-push",
  "env": {
    "GAR_LOCATION": "us-central1",
    "GAR_PROJECT": "<your-gar_project>",
    "GAR_REPOSITORY": "<your-gar_repository>",
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
