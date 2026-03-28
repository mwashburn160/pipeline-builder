# acr-push

Push container images to Azure Container Registry with Azure CLI service principal authentication using AWS CDK CodeBuildStep

**Version:** 1.0.0  
**Category:** artifact  
**Plugin Type:** CodeBuildStep  
**Compute:** MEDIUM  
**Timeout:** 15 minutes  
**Failure Behavior:** fail  

## Keywords

`container`, `docker`, `azure`, `registry`

## Requirements

- Docker (for container image builds)
- Azure CLI
- 3 required secret(s) configured in AWS Secrets Manager (see [Secrets](#secrets) below)

## Secrets

| Name | Required | Description |
|------|----------|-------------|
| `AZURE_CLIENT_ID` | Yes | Azure service principal client ID |
| `AZURE_CLIENT_SECRET` | Yes | Azure service principal client secret |
| `AZURE_TENANT_ID` | Yes | Azure tenant ID |

### Setting Up Secrets

Secrets are injected at build time via AWS CodeBuild environment variables backed by AWS Secrets Manager.

**Step 1: Store secrets in AWS Secrets Manager**

```bash
aws secretsmanager create-secret --name "AZURE_CLIENT_ID" --secret-string "<your-value>"
aws secretsmanager create-secret --name "AZURE_CLIENT_SECRET" --secret-string "<your-value>"
aws secretsmanager create-secret --name "AZURE_TENANT_ID" --secret-string "<your-value>"
```

**Step 2: Reference secrets in your pipeline configuration**

When configuring this plugin in your pipeline, map each secret to the corresponding AWS Secrets Manager ARN:

```json
{
  "secrets": {
    "AZURE_CLIENT_ID": "arn:aws:secretsmanager:<region>:<account>:secret:AZURE_CLIENT_ID",
    "AZURE_CLIENT_SECRET": "arn:aws:secretsmanager:<region>:<account>:secret:AZURE_CLIENT_SECRET",
    "AZURE_TENANT_ID": "arn:aws:secretsmanager:<region>:<account>:secret:AZURE_TENANT_ID"
  }
}
```

**Step 3: IAM permissions**

Ensure the CodeBuild service role has `secretsmanager:GetSecretValue` permission for the referenced secrets.

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `ACR_REGISTRY` | _none_ | Azure Container Registry name |
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
  "name": "acr-push",
  "plugin": "acr-push",
  "env": {
    "ACR_REGISTRY": "<your-acr_registry>",
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
