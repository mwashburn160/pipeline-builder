# pagerduty-notify

PagerDuty incident trigger plugin for alerting on-call teams about pipeline failures and critical events via Events API v2 using AWS CDK CodeBuildStep

**Version:** 1.0.0  
**Category:** notification  
**Plugin Type:** CodeBuildStep  
**Compute:** SMALL  
**Timeout:** 5 minutes  
**Failure Behavior:** warn  

## Keywords

`pagerduty`, `on-call`, `incident`, `alert`

## Requirements

- curl and jq (included in container image)
- 1 required secret configured in AWS Secrets Manager (see [Secrets](#secrets) below)

## Secrets

| Name | Required | Description |
|------|----------|-------------|
| `PAGERDUTY_ROUTING_KEY` | Yes | PagerDuty Events API routing key |

### Setting Up Secrets

Secrets are injected at build time via AWS CodeBuild environment variables backed by AWS Secrets Manager.

**Step 1: Store secrets in AWS Secrets Manager**

```bash
aws secretsmanager create-secret --name "PAGERDUTY_ROUTING_KEY" --secret-string "<your-value>"
```

**Step 2: Reference secrets in your pipeline configuration**

When configuring this plugin in your pipeline, map each secret to the corresponding AWS Secrets Manager ARN:

```json
{
  "secrets": {
    "PAGERDUTY_ROUTING_KEY": "arn:aws:secretsmanager:<region>:<account>:secret:PAGERDUTY_ROUTING_KEY"
  }
}
```

**Step 3: IAM permissions**

Ensure the CodeBuild service role has `secretsmanager:GetSecretValue` permission for the referenced secrets.

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `NOTIFICATION_TYPE` | `trigger` | Event action type: `trigger` or `resolve` |
| `PIPELINE_NAME` | _none_ | Name of the pipeline for incident context |
| `PIPELINE_STATUS` | _none_ | Current pipeline status (e.g., failed, success) |
| `PD_SEVERITY` | `critical` | Incident severity: `critical`, `error`, `warning`, or `info` |
| `PD_SOURCE` | _none_ | Source identifier for the incident (defaults to pipeline name) |

## Output

Primary output directory: `notify-output`

## Usage

This plugin runs as an AWS CDK `CodeBuildStep` within the Pipeline Builder platform. Add it as a step in your pipeline configuration:

```json
{
  "name": "pagerduty-notify",
  "plugin": "pagerduty-notify",
  "env": {
    "NOTIFICATION_TYPE": "trigger",
    "PIPELINE_NAME": "<your-pipeline_name>",
    "PIPELINE_STATUS": "<your-pipeline_status>",
    "PD_SEVERITY": "critical",
    "PD_SOURCE": "<your-pd_source>"
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
