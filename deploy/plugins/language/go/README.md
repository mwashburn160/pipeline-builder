# go

Go plugin for building and testing Go applications with AWS CDK CodeBuildStep

**Version:** 1.0.0  
**Category:** language  
**Plugin Type:** CodeBuildStep  
**Compute:** MEDIUM  
**Timeout:** 15 minutes  
**Failure Behavior:** fail  

## Keywords

`go`, `golang`

## Requirements

- Go 1.22.10

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `GO_VERSION` | `1.22.10` | Go version to use |

## Output

Primary output directory: `**/*`

## Usage

This plugin runs as an AWS CDK `CodeBuildStep` within the Pipeline Builder platform. Add it as a step in your pipeline configuration:

```json
{
  "name": "go",
  "plugin": "go",
  "env": {
    "GO_VERSION": "1.22.10"
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
