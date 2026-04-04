# dotnet-security-scan

dotnet security scan plugin for detecting security vulnerabilities in .NET project dependencies and code using AWS CDK CodeBuildStep

**Version:** 1.0.0  
**Category:** security  
**Plugin Type:** CodeBuildStep  
**Compute:** SMALL  
**Timeout:** 15 minutes  
**Failure Behavior:** fail  

## Keywords

`dotnet`, `dependency-scan`, `vulnerability`, `cve`

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `DOTNET_VERSION` | `8.0` | Dotnet Version |

## Output

Primary output directory: `security-reports`

## Usage

This plugin runs as an AWS CDK `CodeBuildStep` within the Pipeline Builder platform. Add it as a step in your pipeline configuration:

```json
{
  "name": "dotnet-security-scan",
  "plugin": "dotnet-security-scan",
  "env": {
    "DOTNET_VERSION": "8.0"
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
