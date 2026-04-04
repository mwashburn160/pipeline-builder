# roslyn-analyzers

Roslyn analyzers plugin for enforcing code quality rules and treating warnings as errors in .NET builds using AWS CDK CodeBuildStep

**Version:** 1.0.0  
**Category:** quality  
**Plugin Type:** CodeBuildStep  
**Compute:** SMALL  
**Timeout:** 15 minutes  
**Failure Behavior:** fail  

## Keywords

`dotnet`, `csharp`, `static-analysis`, `code-quality`

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `DOTNET_VERSION` | `8.0` | Dotnet Version |
| `TREAT_WARNINGS_AS_ERRORS` | `true` | Treat Warnings As Errors |

## Output

Primary output directory: `analysis-reports`

## Usage

This plugin runs as an AWS CDK `CodeBuildStep` within the Pipeline Builder platform. Add it as a step in your pipeline configuration:

```json
{
  "name": "roslyn-analyzers",
  "plugin": "roslyn-analyzers",
  "env": {
    "DOTNET_VERSION": "8.0",
    "TREAT_WARNINGS_AS_ERRORS": "true"
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
