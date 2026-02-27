# newrelic

New Relic deployment marker plugin for recording deployments and correlating releases with application performance metrics using AWS CDK CodeBuildStep

**Version:** 1.0.0  
**Category:** monitoring  
**Plugin Type:** CodeBuildStep  
**Compute:** SMALL  
**Timeout:** 10 minutes  
**Failure Behavior:** warn  

## Keywords

`newrelic`, `monitoring`, `deploy`, `apm`, `observability`

## Requirements

- Python
- 1 required secret(s) configured in AWS Secrets Manager (see [Secrets](#secrets) below)

## Secrets

| Name | Required | Description |
|------|----------|-------------|
| `NEW_RELIC_API_KEY` | Yes | New Relic API key |

### Setting Up Secrets

Secrets are injected at build time via AWS CodeBuild environment variables backed by AWS Secrets Manager.

**Step 1: Store secrets in AWS Secrets Manager**

```bash
aws secretsmanager create-secret --name "NEW_RELIC_API_KEY" --secret-string "<your-value>"
```

**Step 2: Reference secrets in your pipeline configuration**

When configuring this plugin in your pipeline, map each secret to the corresponding AWS Secrets Manager ARN:

```json
{
  "secrets": {
    "NEW_RELIC_API_KEY": "arn:aws:secretsmanager:<region>:<account>:secret:NEW_RELIC_API_KEY"
  }
}
```

**Step 3: IAM permissions**

Ensure the CodeBuild service role has `secretsmanager:GetSecretValue` permission for the referenced secrets.

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `NR_APP_ID` | _none_ | Nr App Id |
| `NR_REVISION` | _none_ | Nr Revision |
| `NR_DESCRIPTION` | _none_ | Nr Description |
| `NR_USER` | _none_ | Nr User |

## Output

Primary output directory: `newrelic-output`

## Usage

This plugin runs as an AWS CDK `CodeBuildStep` within the Pipeline Builder platform. Add it as a step in your pipeline configuration:

```json
{
  "name": "newrelic",
  "plugin": "newrelic",
  "env": {
    "NR_APP_ID": "<your-nr_app_id>",
    "NR_REVISION": "<your-nr_revision>",
    "NR_DESCRIPTION": "<your-nr_description>",
    "NR_USER": "<your-nr_user>"
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
