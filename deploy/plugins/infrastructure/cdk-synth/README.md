# cdk-synth

Synthesizes AWS CDK applications into CloudFormation templates using CodeBuildStep with Docker

**Version:** 1.0.0  
**Category:** infrastructure  
**Plugin Type:** CodeBuildStep  
**Compute:** MEDIUM  
**Timeout:** 45 minutes  
**Failure Behavior:** fail  

## Keywords

`aws`, `cdk`, `cloudformation`, `synthesize`

## Requirements

- Node.js 24

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `CDK_DEFAULT_REGION` | `${AWS_REGION}` | Cdk Default Region |
| `CDK_DEFAULT_ACCOUNT` | `${AWS_ACCOUNT_ID}` | Cdk Default Account |

## Output

Primary output directory: `cdk.out`

## Usage

This plugin runs as an AWS CDK `CodeBuildStep` within the Pipeline Builder platform. Add it as a step in your pipeline configuration:

```json
{
  "name": "cdk-synth",
  "plugin": "cdk-synth",
  "env": {
    "CDK_DEFAULT_REGION": "${AWS_REGION}",
    "CDK_DEFAULT_ACCOUNT": "${AWS_ACCOUNT_ID}"
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
