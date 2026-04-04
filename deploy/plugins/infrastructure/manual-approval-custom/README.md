# manual-approval-custom

Custom pipeline approval gate using SNS/SSM polling — publishes an SNS notification and polls SSM Parameter Store for approval response via AWS CDK CodeBuildStep

**Version:** 1.0.0  
**Category:** infrastructure  
**Plugin Type:** CodeBuildStep  
**Compute:** SMALL  
**Timeout:** 60 minutes  
**Failure Behavior:** fail  

## Keywords

`approval`, `gate`, `sns`, `ssm`

## Requirements

- AWS CLI configured with appropriate permissions

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `APPROVAL_TOPIC_ARN` | _none_ | Approval Topic Arn |
| `APPROVAL_MESSAGE` | `Pipeline requires manual approval` | Message shown during manual approval |
| `APPROVAL_TIMEOUT` | `3600` | Manual approval timeout in seconds |
| `APPROVAL_URL` | _none_ | Approval Url |

## Output

Primary output directory: `approval-output`

## Usage

This plugin runs as an AWS CDK `CodeBuildStep` within the Pipeline Builder platform. Add it as a step in your pipeline configuration:

```json
{
  "name": "manual-approval-custom",
  "plugin": "manual-approval-custom",
  "env": {
    "APPROVAL_TOPIC_ARN": "<your-approval_topic_arn>",
    "APPROVAL_MESSAGE": "Pipeline requires manual approval",
    "APPROVAL_TIMEOUT": "3600",
    "APPROVAL_URL": "<your-approval_url>"
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
