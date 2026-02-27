# java-oracle

Java and Kotlin plugin using Oracle GraalVM JDK for building and testing JVM applications with optional native-image compilation using AWS CDK CodeBuildStep

**Version:** 1.0.0  
**Category:** language  
**Plugin Type:** CodeBuildStep  
**Compute:** LARGE  
**Timeout:** 15 minutes  
**Failure Behavior:** fail  

## Keywords

`java`, `kotlin`, `jvm`, `oracle`, `graalvm`, `native-image`, `maven`, `gradle`, `quarkus`, `micronaut`, `ktor`

## Requirements

- Java 21.0.5-graal

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `JAVA_VERSION` | `21.0.5-graal` | Java SDK version to use |
| `KOTLIN_VERSION` | `2.1.0` | Kotlin Version |
| `BUILD_TOOL` | `auto` | Build Tool |
| `NATIVE_BUILD` | `false` | Native Build |

## Output

Primary output directory: `**/*`

## Usage

This plugin runs as an AWS CDK `CodeBuildStep` within the Pipeline Builder platform. Add it as a step in your pipeline configuration:

```json
{
  "name": "java-oracle",
  "plugin": "java-oracle",
  "env": {
    "JAVA_VERSION": "21.0.5-graal",
    "KOTLIN_VERSION": "2.1.0",
    "BUILD_TOOL": "auto",
    "NATIVE_BUILD": "false"
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
