# java-corretto

Java and Kotlin plugin using Amazon Corretto JDK for building and testing JVM applications optimized for AWS workloads with AWS CDK CodeBuildStep

**Version:** 1.0.0  
**Category:** language  
**Plugin Type:** CodeBuildStep  
**Compute:** MEDIUM  
**Timeout:** 15 minutes  
**Failure Behavior:** fail  

## Keywords

`java`, `kotlin`, `corretto`, `aws`

## Requirements

- Amazon Corretto JDK 21

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `BUILD_TOOL` | `auto` | Build Tool |

## Output

Primary output directory: `**/*`

## Usage

This plugin runs as an AWS CDK `CodeBuildStep` within the Pipeline Builder platform. Add it as a step in your pipeline configuration:

```json
{
  "name": "java-corretto",
  "plugin": "java-corretto",
  "env": {
    "BUILD_TOOL": "auto"
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
