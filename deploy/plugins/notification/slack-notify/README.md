# slack-notify

Slack notification plugin for sending pipeline status alerts, build results, and custom messages to Slack channels via webhook using AWS CDK CodeBuildStep

**Version:** 1.0.0  
**Category:** notification  
**Plugin Type:** CodeBuildStep  
**Compute:** SMALL  
**Timeout:** 5 minutes  
**Failure Behavior:** warn  

## Keywords

`slack`, `webhook`, `notification`, `alert`

## Requirements

- curl and jq (included in container image)
- 1 required secret configured in AWS Secrets Manager (see [Secrets](#secrets) below)

## Secrets

| Name | Required | Description |
|------|----------|-------------|
| `SLACK_WEBHOOK_URL` | Yes | Slack incoming webhook URL |

### Setting Up Secrets

Secrets are injected at build time via AWS CodeBuild environment variables backed by AWS Secrets Manager.

**Step 1: Store secrets in AWS Secrets Manager**

```bash
aws secretsmanager create-secret --name "SLACK_WEBHOOK_URL" --secret-string "<your-value>"
```

**Step 2: Reference secrets in your pipeline configuration**

When configuring this plugin in your pipeline, map each secret to the corresponding AWS Secrets Manager ARN:

```json
{
  "secrets": {
    "SLACK_WEBHOOK_URL": "arn:aws:secretsmanager:<region>:<account>:secret:SLACK_WEBHOOK_URL"
  }
}
```

**Step 3: IAM permissions**

Ensure the CodeBuild service role has `secretsmanager:GetSecretValue` permission for the referenced secrets.

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `NOTIFICATION_TYPE` | `pipeline-status` | Message type: `pipeline-status` or `custom` |
| `PIPELINE_NAME` | _none_ | Name of the pipeline for status messages |
| `PIPELINE_STATUS` | _none_ | Current pipeline status (e.g., success, failure) |
| `CUSTOM_MESSAGE` | _none_ | Custom message text (required when type is `custom`) |
| `MENTION_ON_FAILURE` | _none_ | Slack user/group mention on failure (e.g., `@oncall`) |

## Output

Primary output directory: `notify-output`

## Usage

This plugin runs as an AWS CDK `CodeBuildStep` within the Pipeline Builder platform. Add it as a step in your pipeline configuration:

```json
{
  "name": "slack-notify",
  "plugin": "slack-notify",
  "env": {
    "NOTIFICATION_TYPE": "pipeline-status",
    "PIPELINE_NAME": "<your-pipeline_name>",
    "PIPELINE_STATUS": "<your-pipeline_status>",
    "CUSTOM_MESSAGE": "<your-custom_message>",
    "MENTION_ON_FAILURE": "<your-mention_on_failure>"
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
