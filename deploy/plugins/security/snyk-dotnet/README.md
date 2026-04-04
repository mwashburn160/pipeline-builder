# snyk-dotnet

Snyk security scanning for .NET projects using AWS CDK with CodeBuildStep

**Version:** 1.0.0  
**Category:** security  
**Plugin Type:** CodeBuildStep  
**Compute:** SMALL  
**Timeout:** 15 minutes  
**Failure Behavior:** fail  

## Keywords

`dotnet`, `sca`, `vulnerability`, `dependency-scan`

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `SNYK_SEVERITY_THRESHOLD` | `high` | Snyk Severity Threshold |
| `DOTNET_VERSION` | `9.0` | Dotnet Version |

## Output

Primary output directory: `snyk-reports`

## Usage

This plugin runs as an AWS CDK `CodeBuildStep` within the Pipeline Builder platform. Add it as a step in your pipeline configuration:

```json
{
  "name": "snyk-dotnet",
  "plugin": "snyk-dotnet",
  "env": {
    "SNYK_SEVERITY_THRESHOLD": "high",
    "DOTNET_VERSION": "9.0"
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
