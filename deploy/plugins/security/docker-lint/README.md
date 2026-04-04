# docker-lint

Docker linting and container security plugin using Hadolint for Dockerfile best practices and Dockle for CIS benchmark compliance using AWS CDK CodeBuildStep

**Version:** 1.0.0  
**Category:** security  
**Plugin Type:** CodeBuildStep  
**Compute:** SMALL  
**Timeout:** 30 minutes  
**Failure Behavior:** fail  

## Keywords

`docker`, `hadolint`, `dockle`, `best-practices`

## Requirements

- Node.js

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `HADOLINT_VERSION` | `2.12.0` | Hadolint Version |
| `DOCKLE_VERSION` | `0.4.15` | Dockle Version |
| `DOCKERFILE_PATH` | `Dockerfile` | Path to the Dockerfile |
| `DOCKER_IMAGE` | _none_ | Docker Image |
| `HADOLINT_FORMAT` | `json` | Hadolint Format |
| `DOCKLE_FORMAT` | `json` | Dockle Format |
| `HADOLINT_SEVERITY` | `warning` | Hadolint Severity |

## Output

Primary output directory: `docker-lint-reports`

## Usage

This plugin runs as an AWS CDK `CodeBuildStep` within the Pipeline Builder platform. Add it as a step in your pipeline configuration:

```json
{
  "name": "docker-lint",
  "plugin": "docker-lint",
  "env": {
    "HADOLINT_VERSION": "2.12.0",
    "DOCKLE_VERSION": "0.4.15",
    "DOCKERFILE_PATH": "Dockerfile",
    "DOCKER_IMAGE": "<your-docker_image>",
    "HADOLINT_FORMAT": "json",
    "DOCKLE_FORMAT": "json",
    "HADOLINT_SEVERITY": "warning"
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
