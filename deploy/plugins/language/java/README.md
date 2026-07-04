# java

Java and Kotlin plugin for building and testing JVM applications using Maven or Gradle with AWS CDK CodeBuildStep

**Version:** 1.0.0  
**Category:** language  
**Plugin Type:** CodeBuildStep  
**Compute:** MEDIUM  
**Timeout:** 15 minutes  
**Failure Behavior:** fail  

## Keywords

`java`, `kotlin`, `maven`, `gradle`

## Requirements

- Java 21.0.10-tem

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
  "name": "java",
  "plugin": "java",
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
