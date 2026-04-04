# ecr-push

Push container images to Amazon ECR with AWS CLI authentication and Docker Buildx support using AWS CDK CodeBuildStep

**Version:** 1.0.0  
**Category:** artifact  
**Plugin Type:** CodeBuildStep  
**Compute:** MEDIUM  
**Timeout:** 15 minutes  
**Failure Behavior:** fail  

## Keywords

`container`, `docker`, `ecr`, `registry`

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `ECR_REPOSITORY` | `` | Ecr Repository |
| `IMAGE_TAG` | `latest` | Image Tag |
| `DOCKERFILE_PATH` | `Dockerfile` | Dockerfile Path |
| `DOCKER_CONTEXT` | `.` | Docker Context |
| `AWS_REGION` | `${AWS_REGION}` | Aws Region |
| `AWS_ACCOUNT_ID` | `${AWS_ACCOUNT_ID}` | Aws Account Id |

## Output

Primary output directory: `registry-output`

## Usage

This plugin runs as an AWS CDK `CodeBuildStep` within the Pipeline Builder platform. Add it as a step in your pipeline configuration:

```json
{
  "name": "ecr-push",
  "plugin": "ecr-push",
  "env": {
    "ECR_REPOSITORY": "",
    "IMAGE_TAG": "latest",
    "DOCKERFILE_PATH": "Dockerfile",
    "DOCKER_CONTEXT": ".",
    "AWS_REGION": "${AWS_REGION}",
    "AWS_ACCOUNT_ID": "${AWS_ACCOUNT_ID}"
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
