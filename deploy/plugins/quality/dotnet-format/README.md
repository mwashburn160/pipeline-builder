# dotnet-format

dotnet format plugin for verifying consistent C# and .NET code formatting using AWS CDK CodeBuildStep

**Version:** 1.0.0  
**Category:** quality  
**Plugin Type:** CodeBuildStep  
**Compute:** SMALL  
**Timeout:** 10 minutes  
**Failure Behavior:** fail  

## Keywords

`dotnet`, `csharp`, `formatting`, `code-style`

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `DOTNET_VERSION` | `8.0` | Dotnet Version |

## Output

Primary output directory: `format-reports`

## Usage

This plugin runs as an AWS CDK `CodeBuildStep` within the Pipeline Builder platform. Add it as a step in your pipeline configuration:

```json
{
  "name": "dotnet-format",
  "plugin": "dotnet-format",
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
