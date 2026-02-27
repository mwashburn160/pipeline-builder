# manual-approval

Native CDK pipeline approval gate that pauses execution and waits for manual confirmation via the AWS CodePipeline console

**Version:** 1.0.0  
**Category:** infrastructure  
**Plugin Type:** ManualApprovalStep  
**Compute:** SMALL  
**Timeout:** 0 minutes  
**Failure Behavior:** fail  

## Keywords

`approval`, `gate`, `manual`, `pipeline`, `infrastructure`

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `APPROVAL_COMMENT` | `Pipeline requires manual approval before proceeding` | Approval Comment |

## Usage

This plugin runs as an AWS CDK `CodeBuildStep` within the Pipeline Builder platform. Add it as a step in your pipeline configuration:

```json
{
  "name": "manual-approval",
  "plugin": "manual-approval",
  "env": {
    "APPROVAL_COMMENT": "Pipeline requires manual approval before proceeding"
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
