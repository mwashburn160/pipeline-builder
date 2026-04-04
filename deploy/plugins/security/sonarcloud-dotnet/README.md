# sonarcloud-dotnet

SonarCloud code quality and security analysis for .NET projects using AWS CDK with CodeBuildStep

**Version:** 1.0.0  
**Category:** security  
**Plugin Type:** CodeBuildStep  
**Compute:** SMALL  
**Timeout:** 15 minutes  
**Failure Behavior:** fail  

## Keywords

`dotnet`, `code-quality`, `security-analysis`, `coverage`

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `SONAR_SCANNER_VERSION` | `12.0` | Sonar Scanner Version |
| `SONAR_ORGANIZATION` | `` | Sonar Organization |
| `SONAR_PROJECT_KEY` | `` | Sonar Project Key |
| `DOTNET_VERSION` | `9.0` | Dotnet Version |

## Output

Primary output directory: `.scannerwork`

## Usage

This plugin runs as an AWS CDK `CodeBuildStep` within the Pipeline Builder platform. Add it as a step in your pipeline configuration:

```json
{
  "name": "sonarcloud-dotnet",
  "plugin": "sonarcloud-dotnet",
  "env": {
    "SONAR_SCANNER_VERSION": "12.0",
    "SONAR_ORGANIZATION": "",
    "SONAR_PROJECT_KEY": "",
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
