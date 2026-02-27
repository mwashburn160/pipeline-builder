# prisma-cloud

Prisma Cloud (Palo Alto) container image and IaC security scanning plugin with Checkov for infrastructure compliance using AWS CDK CodeBuildStep

**Version:** 1.0.0  
**Category:** security  
**Plugin Type:** CodeBuildStep  
**Compute:** MEDIUM  
**Timeout:** 30 minutes  
**Failure Behavior:** fail  

## Keywords

`prisma`, `twistlock`, `palo-alto`, `container`, `iac`, `security`, `compliance`, `checkov`

## Requirements

- Docker (for container image builds)
- 2 required secret(s) configured in AWS Secrets Manager (see [Secrets](#secrets) below)

## Secrets

| Name | Required | Description |
|------|----------|-------------|
| `PRISMA_ACCESS_KEY` | Yes | Prisma Cloud access key |
| `PRISMA_SECRET_KEY` | Yes | Prisma Cloud secret key |

### Setting Up Secrets

Secrets are injected at build time via AWS CodeBuild environment variables backed by AWS Secrets Manager.

**Step 1: Store secrets in AWS Secrets Manager**

```bash
aws secretsmanager create-secret --name "PRISMA_ACCESS_KEY" --secret-string "<your-value>"
aws secretsmanager create-secret --name "PRISMA_SECRET_KEY" --secret-string "<your-value>"
```

**Step 2: Reference secrets in your pipeline configuration**

When configuring this plugin in your pipeline, map each secret to the corresponding AWS Secrets Manager ARN:

```json
{
  "secrets": {
    "PRISMA_ACCESS_KEY": "arn:aws:secretsmanager:<region>:<account>:secret:PRISMA_ACCESS_KEY",
    "PRISMA_SECRET_KEY": "arn:aws:secretsmanager:<region>:<account>:secret:PRISMA_SECRET_KEY"
  }
}
```

**Step 3: IAM permissions**

Ensure the CodeBuild service role has `secretsmanager:GetSecretValue` permission for the referenced secrets.

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `PRISMA_CONSOLE_URL` | _none_ | Prisma Console Url |
| `PRISMA_SCAN_TYPE` | `iac` | Prisma Scan Type |
| `PRISMA_SEVERITY` | `high` | Prisma Severity |
| `DOCKER_IMAGE` | _none_ | Docker Image |

## Output

Primary output directory: `prisma-reports`

## Usage

This plugin runs as an AWS CDK `CodeBuildStep` within the Pipeline Builder platform. Add it as a step in your pipeline configuration:

```json
{
  "name": "prisma-cloud",
  "plugin": "prisma-cloud",
  "env": {
    "PRISMA_CONSOLE_URL": "<your-prisma_console_url>",
    "PRISMA_SCAN_TYPE": "iac",
    "PRISMA_SEVERITY": "high",
    "DOCKER_IMAGE": "<your-docker_image>"
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
