# dotnet

.NET plugin for building and testing C#/F# applications using dotnet CLI with AWS CDK CodeBuildStep

**Version:** 1.0.0  
**Category:** language  
**Plugin Type:** CodeBuildStep  
**Compute:** MEDIUM  
**Timeout:** 15 minutes  
**Failure Behavior:** fail  

## Keywords

`dotnet`, `csharp`, `fsharp`, `build`

## Requirements

- .NET SDK 9.0

## Output

Primary output directory: `**/*`

## Usage

This plugin runs as an AWS CDK `CodeBuildStep` within the Pipeline Builder platform. Add it as a step in your pipeline configuration:

```json
{
  "name": "dotnet",
  "plugin": "dotnet"
}
```

## Files

| File | Description |
|------|-------------|
| `plugin-spec.yaml` | Plugin configuration and build commands |
| `Dockerfile` | Container image definition |
| `plugin.zip` | Packaged plugin archive |
| `README.md` | This documentation file |
