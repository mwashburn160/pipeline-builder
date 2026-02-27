# java-ibm

Java and Kotlin plugin using IBM Semeru Runtime (OpenJ9 JVM) for building and testing JVM applications with lower memory footprint using AWS CDK CodeBuildStep

**Version:** 1.0.0  
**Category:** language  
**Plugin Type:** CodeBuildStep  
**Compute:** MEDIUM  
**Timeout:** 15 minutes  
**Failure Behavior:** fail  

## Keywords

`java`, `kotlin`, `jvm`, `ibm`, `semeru`, `openj9`, `maven`, `gradle`, `ktor`

## Requirements

- Java 17.0.13-sem

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `JAVA_VERSION` | `17.0.13-sem` | Java SDK version to use |
| `KOTLIN_VERSION` | `2.1.0` | Kotlin Version |
| `BUILD_TOOL` | `auto` | Build Tool |

## Output

Primary output directory: `**/*`

## Usage

This plugin runs as an AWS CDK `CodeBuildStep` within the Pipeline Builder platform. Add it as a step in your pipeline configuration:

```json
{
  "name": "java-ibm",
  "plugin": "java-ibm",
  "env": {
    "JAVA_VERSION": "17.0.13-sem",
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
