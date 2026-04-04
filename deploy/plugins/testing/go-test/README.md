# go-test

Go test runner plugin for executing unit and integration tests with coverage reporting using AWS CDK CodeBuildStep

**Version:** 1.0.0  
**Category:** testing  
**Plugin Type:** CodeBuildStep  
**Compute:** SMALL  
**Timeout:** 20 minutes  
**Failure Behavior:** fail  

## Keywords

`go`, `unit-test`, `integration-test`, `coverage`

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `GO_VERSION` | `1.24.13` | Go Version |
| `GOFLAGS` | `-count=1` | Goflags |

## Output

Primary output directory: `test-reports`

## Usage

This plugin runs as an AWS CDK `CodeBuildStep` within the Pipeline Builder platform. Add it as a step in your pipeline configuration:

```json
{
  "name": "go-test",
  "plugin": "go-test",
  "env": {
    "GO_VERSION": "1.24.13",
    "GOFLAGS": "-count=1"
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
