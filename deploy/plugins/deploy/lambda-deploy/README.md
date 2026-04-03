# lambda-deploy

AWS Lambda function deployment plugin for updating code, publishing versions, and managing aliases with zip or container image packaging using AWS CDK CodeBuildStep

**Version:** 1.0.0
**Category:** deploy
**Plugin Type:** CodeBuildStep
**Compute:** SMALL
**Timeout:** 15 minutes
**Failure Behavior:** fail

## Keywords

`aws`, `lambda`, `serverless`, `deploy`

## Requirements

- AWS CLI configured with appropriate permissions

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `LAMBDA_FUNCTION` | _none_ | Lambda function name or ARN |
| `LAMBDA_PACKAGE_TYPE` | `zip` | Package type: zip or image |
| `LAMBDA_SOURCE_DIR` | `.` | Source directory to package (zip type only) |
| `LAMBDA_IMAGE_URI` | _none_ | Container image URI (image type only) |
| `LAMBDA_HANDLER` | _none_ | Lambda handler (e.g., index.handler) |
| `LAMBDA_ALIAS` | _none_ | Alias to update after publishing a new version |
| `LAMBDA_PUBLISH` | `false` | Publish a new version after code update |

## Output

Primary output directory: `lambda-output`

## Usage

This plugin runs as an AWS CDK `CodeBuildStep` within the Pipeline Builder platform. Add it as a step in your pipeline configuration:

```json
{
  "name": "lambda-deploy",
  "plugin": "lambda-deploy",
  "env": {
    "LAMBDA_FUNCTION": "<your-function-name>",
    "LAMBDA_PACKAGE_TYPE": "zip",
    "LAMBDA_SOURCE_DIR": ".",
    "LAMBDA_PUBLISH": "false"
  }
}
```

## Files

| File | Description |
|------|-------------|
| `spec.yaml` | Plugin configuration and build commands |
| `Dockerfile` | Container image definition |
| `plugin.zip` | Packaged plugin archive |
| `README.md` | This documentation file |
