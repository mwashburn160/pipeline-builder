# datadog

Datadog deployment tracking plugin for sending deploy events and markers to Datadog APM for observability and release correlation using AWS CDK CodeBuildStep

**Version:** 1.0.0  
**Category:** monitoring  
**Plugin Type:** CodeBuildStep  
**Compute:** SMALL  
**Timeout:** 10 minutes  
**Failure Behavior:** warn  

## Keywords

`datadog`, `deploy-tracking`, `apm`, `observability`

## Requirements

- curl and jq (included in container image)
- 1 required secret configured in AWS Secrets Manager (see [Secrets](#secrets) below)

## Secrets

| Name | Required | Description |
|------|----------|-------------|
| `DD_API_KEY` | Yes | Datadog API key |

### Setting Up Secrets

Secrets are injected at build time via AWS CodeBuild environment variables backed by AWS Secrets Manager.

**Step 1: Store secrets in AWS Secrets Manager**

```bash
aws secretsmanager create-secret --name "DD_API_KEY" --secret-string "<your-value>"
```

**Step 2: Reference secrets in your pipeline configuration**

When configuring this plugin in your pipeline, map each secret to the corresponding AWS Secrets Manager ARN:

```json
{
  "secrets": {
    "DD_API_KEY": "arn:aws:secretsmanager:<region>:<account>:secret:DD_API_KEY"
  }
}
```

**Step 3: IAM permissions**

Ensure the CodeBuild service role has `secretsmanager:GetSecretValue` permission for the referenced secrets.

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `DD_SITE` | `datadoghq.com` | Datadog site (e.g., datadoghq.com) |
| `DD_SERVICE` | _none_ | Datadog service name for tagging |
| `DD_ENV` | `production` | Deployment environment name |
| `DD_VERSION` | _none_ | Application version being deployed |

## Output

Primary output directory: `datadog-output`

## Usage

This plugin runs as an AWS CDK `CodeBuildStep` within the Pipeline Builder platform. Add it as a step in your pipeline configuration:

```json
{
  "name": "datadog",
  "plugin": "datadog",
  "env": {
    "DD_SITE": "datadoghq.com",
    "DD_SERVICE": "<your-dd_service>",
    "DD_ENV": "production",
    "DD_VERSION": "<your-dd_version>"
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
