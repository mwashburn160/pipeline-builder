# email-notify

Email notification plugin for sending pipeline status alerts via AWS SES or SMTP with configurable templates and recipients using AWS CDK CodeBuildStep

**Version:** 1.0.0
**Category:** notification
**Plugin Type:** CodeBuildStep
**Compute:** SMALL
**Timeout:** 5 minutes
**Failure Behavior:** warn

## Keywords

`email`, `ses`, `smtp`, `notification`

## Requirements

- AWS CLI v2 (included in container image)
- Python 3 (included in container image, used for SMTP provider)
- 0-1 secret(s) configured in AWS Secrets Manager (see [Secrets](#secrets) below)

## Secrets

| Name | Required | Description |
|------|----------|-------------|
| `SMTP_PASSWORD` | No | SMTP password (not needed for SES with IAM roles) |

### Setting Up Secrets

Secrets are injected at build time via AWS CodeBuild environment variables backed by AWS Secrets Manager.

**Step 1: Store secrets in AWS Secrets Manager**

```bash
aws secretsmanager create-secret --name "SMTP_PASSWORD" --secret-string "<your-value>"
```

**Step 2: Reference secrets in your pipeline configuration**

When configuring this plugin in your pipeline, map each secret to the corresponding AWS Secrets Manager ARN:

```json
{
  "secrets": {
    "SMTP_PASSWORD": "arn:aws:secretsmanager:<region>:<account>:secret:SMTP_PASSWORD"
  }
}
```

**Step 3: IAM permissions**

Ensure the CodeBuild service role has `secretsmanager:GetSecretValue` permission for the referenced secrets. For the SES provider, the role also needs `ses:SendEmail` permission.

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `EMAIL_PROVIDER` | `ses` | Email provider: `ses` (AWS SES) or `smtp` |
| `EMAIL_TO` | _none_ | Recipient email address (required) |
| `EMAIL_FROM` | _none_ | Sender email address |
| `EMAIL_SUBJECT` | `Pipeline Notification` | Email subject line |
| `PIPELINE_NAME` | _none_ | Name of the pipeline for the notification body |
| `PIPELINE_STATUS` | _none_ | Current pipeline status for the notification body |
| `AWS_REGION` | `us-east-1` | AWS region for SES API calls |
| `SMTP_HOST` | _none_ | SMTP server hostname (required for SMTP provider) |
| `SMTP_PORT` | `587` | SMTP server port |

## Output

Primary output directory: `notify-output`

## Usage

This plugin runs as an AWS CDK `CodeBuildStep` within the Pipeline Builder platform. Add it as a step in your pipeline configuration:

```json
{
  "name": "email-notify",
  "plugin": "email-notify",
  "env": {
    "EMAIL_PROVIDER": "ses",
    "EMAIL_TO": "team@example.com",
    "EMAIL_FROM": "pipeline@example.com",
    "PIPELINE_NAME": "<your-pipeline_name>",
    "PIPELINE_STATUS": "<your-pipeline_status>",
    "AWS_REGION": "us-east-1"
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
