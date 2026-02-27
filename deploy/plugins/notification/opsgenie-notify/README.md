# opsgenie-notify

Opsgenie alert plugin for notifying on-call teams about pipeline events and failures via REST API v2 using AWS CDK CodeBuildStep

**Version:** 1.0.0  
**Category:** notification  
**Plugin Type:** CodeBuildStep  
**Compute:** SMALL  
**Timeout:** 5 minutes  
**Failure Behavior:** warn  

## Keywords

`opsgenie`, `alert`, `notification`, `oncall`, `atlassian`

## Requirements

- Python
- 1 required secret(s) configured in AWS Secrets Manager (see [Secrets](#secrets) below)

## Secrets

| Name | Required | Description |
|------|----------|-------------|
| `OPSGENIE_API_KEY` | Yes | Opsgenie API key |

### Setting Up Secrets

Secrets are injected at build time via AWS CodeBuild environment variables backed by AWS Secrets Manager.

**Step 1: Store secrets in AWS Secrets Manager**

```bash
aws secretsmanager create-secret --name "OPSGENIE_API_KEY" --secret-string "<your-value>"
```

**Step 2: Reference secrets in your pipeline configuration**

When configuring this plugin in your pipeline, map each secret to the corresponding AWS Secrets Manager ARN:

```json
{
  "secrets": {
    "OPSGENIE_API_KEY": "arn:aws:secretsmanager:<region>:<account>:secret:OPSGENIE_API_KEY"
  }
}
```

**Step 3: IAM permissions**

Ensure the CodeBuild service role has `secretsmanager:GetSecretValue` permission for the referenced secrets.

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `NOTIFICATION_TYPE` | `alert` | Notification Type |
| `PIPELINE_NAME` | _none_ | Pipeline Name |
| `PIPELINE_STATUS` | _none_ | Pipeline Status |
| `OG_PRIORITY` | `P2` | Og Priority |
| `OG_TEAM` | _none_ | Og Team |

## Output

Primary output directory: `notify-output`

## Usage

This plugin runs as an AWS CDK `CodeBuildStep` within the Pipeline Builder platform. Add it as a step in your pipeline configuration:

```json
{
  "name": "opsgenie-notify",
  "plugin": "opsgenie-notify",
  "env": {
    "NOTIFICATION_TYPE": "alert",
    "PIPELINE_NAME": "<your-pipeline_name>",
    "PIPELINE_STATUS": "<your-pipeline_status>",
    "OG_PRIORITY": "P2",
    "OG_TEAM": "<your-og_team>"
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
