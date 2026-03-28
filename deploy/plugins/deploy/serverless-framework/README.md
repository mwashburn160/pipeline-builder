# serverless-framework

Serverless Framework deployment plugin for deploying serverless applications to AWS, Azure, or GCP with stage and region configuration using AWS CDK CodeBuildStep

**Version:** 1.0.0
**Category:** deploy
**Plugin Type:** CodeBuildStep
**Compute:** MEDIUM
**Timeout:** 30 minutes
**Failure Behavior:** fail

## Keywords

`serverless`, `lambda`, `multi-cloud`, `deploy`

## Requirements

- AWS CLI configured with appropriate permissions
- Node.js 24

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `NODE_VERSION` | `24` | Node.js version to use via nvm |
| `SLS_STAGE` | `dev` | Serverless deployment stage |
| `SLS_REGION` | _none_ | AWS region for deployment (uses Serverless config default if not set) |
| `SLS_SERVICE_PATH` | `.` | Path to the Serverless service directory |

## Output

Primary output directory: `serverless-output`

## Usage

This plugin runs as an AWS CDK `CodeBuildStep` within the Pipeline Builder platform. Add it as a step in your pipeline configuration:

```json
{
  "name": "serverless-framework",
  "plugin": "serverless-framework",
  "env": {
    "SLS_STAGE": "dev",
    "SLS_REGION": "us-east-1",
    "SLS_SERVICE_PATH": "."
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
