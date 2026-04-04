# dotnet-test

dotnet test runner plugin for executing .NET unit and integration tests with TRX reporting and code coverage using AWS CDK CodeBuildStep

**Version:** 1.0.0  
**Category:** testing  
**Plugin Type:** CodeBuildStep  
**Compute:** MEDIUM  
**Timeout:** 30 minutes  
**Failure Behavior:** fail  

## Keywords

`dotnet`, `unit-test`, `integration-test`, `trx`

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `DOTNET_VERSION` | `8.0` | Dotnet Version |
| `CONFIGURATION` | `Release` | Configuration |

## Output

Primary output directory: `test-reports`

## Usage

This plugin runs as an AWS CDK `CodeBuildStep` within the Pipeline Builder platform. Add it as a step in your pipeline configuration:

```json
{
  "name": "dotnet-test",
  "plugin": "dotnet-test",
  "env": {
    "DOTNET_VERSION": "8.0",
    "CONFIGURATION": "Release"
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
