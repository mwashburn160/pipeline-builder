# java-microsoft

Java and Kotlin plugin using Microsoft Build of OpenJDK for building and testing JVM applications optimized for Azure workloads with AWS CDK CodeBuildStep

**Version:** 1.0.0  
**Category:** language  
**Plugin Type:** CodeBuildStep  
**Compute:** MEDIUM  
**Timeout:** 15 minutes  
**Failure Behavior:** fail  

## Keywords

`java`, `kotlin`, `jvm`, `microsoft`, `azure`, `maven`, `gradle`, `ktor`

## Requirements

- Java 17.0.13-ms

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `JAVA_VERSION` | `17.0.13-ms` | Java SDK version to use |
| `KOTLIN_VERSION` | `2.1.0` | Kotlin Version |
| `BUILD_TOOL` | `auto` | Build Tool |

## Output

Primary output directory: `**/*`

## Usage

This plugin runs as an AWS CDK `CodeBuildStep` within the Pipeline Builder platform. Add it as a step in your pipeline configuration:

```json
{
  "name": "java-microsoft",
  "plugin": "java-microsoft",
  "env": {
    "JAVA_VERSION": "17.0.13-ms",
    "KOTLIN_VERSION": "2.1.0",
    "BUILD_TOOL": "auto"
  }
}
```

## Files

| File | Description |
|------|-------------|
| `manifest.yaml` | Plugin configuration and build commands |
| `Dockerfile` | Container image definition |
| `plugin.zip` | Packaged plugin archive |
| `README.md` | This documentation file |
