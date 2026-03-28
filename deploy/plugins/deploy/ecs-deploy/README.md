# ecs-deploy

Amazon ECS service deployment plugin for updating task definitions and services with rolling deployment strategies using AWS CDK CodeBuildStep

**Version:** 1.0.0
**Category:** deploy
**Plugin Type:** CodeBuildStep
**Compute:** SMALL
**Timeout:** 30 minutes
**Failure Behavior:** fail

## Keywords

`aws`, `ecs`, `container`, `deploy`

## Requirements

- AWS CLI configured with appropriate permissions

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `ECS_CLUSTER` | _none_ | ECS cluster name |
| `ECS_SERVICE` | _none_ | ECS service name |
| `IMAGE_URI` | _none_ | Container image URI to deploy |
| `ECS_TASK_FAMILY` | _none_ | Task definition family name (auto-detected if not set) |
| `ECS_WAIT` | `true` | Wait for service to stabilize after deployment |

## Output

Primary output directory: `ecs-output`

## Usage

This plugin runs as an AWS CDK `CodeBuildStep` within the Pipeline Builder platform. Add it as a step in your pipeline configuration:

```json
{
  "name": "ecs-deploy",
  "plugin": "ecs-deploy",
  "env": {
    "ECS_CLUSTER": "<your-ecs-cluster>",
    "ECS_SERVICE": "<your-ecs-service>",
    "IMAGE_URI": "<your-image-uri>",
    "ECS_WAIT": "true"
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
