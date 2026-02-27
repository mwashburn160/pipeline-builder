# discord-notify

Discord notification plugin for sending pipeline status alerts and build results to Discord channels via webhook using AWS CDK CodeBuildStep

**Version:** 1.0.0  
**Category:** notification  
**Plugin Type:** CodeBuildStep  
**Compute:** SMALL  
**Timeout:** 5 minutes  
**Failure Behavior:** warn  

## Keywords

`discord`, `notification`, `alert`, `webhook`, `chat`

## Requirements

- Python
- 1 required secret(s) configured in AWS Secrets Manager (see [Secrets](#secrets) below)

## Secrets

| Name | Required | Description |
|------|----------|-------------|
| `DISCORD_WEBHOOK_URL` | Yes | Discord webhook URL |

### Setting Up Secrets

Secrets are injected at build time via AWS CodeBuild environment variables backed by AWS Secrets Manager.

**Step 1: Store secrets in AWS Secrets Manager**

```bash
aws secretsmanager create-secret --name "DISCORD_WEBHOOK_URL" --secret-string "<your-value>"
```

**Step 2: Reference secrets in your pipeline configuration**

When configuring this plugin in your pipeline, map each secret to the corresponding AWS Secrets Manager ARN:

```json
{
  "secrets": {
    "DISCORD_WEBHOOK_URL": "arn:aws:secretsmanager:<region>:<account>:secret:DISCORD_WEBHOOK_URL"
  }
}
```

**Step 3: IAM permissions**

Ensure the CodeBuild service role has `secretsmanager:GetSecretValue` permission for the referenced secrets.

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `NOTIFICATION_TYPE` | `pipeline-status` | Notification Type |
| `PIPELINE_NAME` | _none_ | Pipeline Name |
| `PIPELINE_STATUS` | _none_ | Pipeline Status |
| `CUSTOM_MESSAGE` | _none_ | Custom Message |

## Output

Primary output directory: `notify-output`

## Usage

This plugin runs as an AWS CDK `CodeBuildStep` within the Pipeline Builder platform. Add it as a step in your pipeline configuration:

```json
{
  "name": "discord-notify",
  "plugin": "discord-notify",
  "env": {
    "NOTIFICATION_TYPE": "pipeline-status",
    "PIPELINE_NAME": "<your-pipeline_name>",
    "PIPELINE_STATUS": "<your-pipeline_status>",
    "CUSTOM_MESSAGE": "<your-custom_message>"
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
