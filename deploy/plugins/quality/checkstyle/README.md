# checkstyle

Checkstyle Java code style enforcement plugin supporting Google, Sun, and custom rule sets using AWS CDK CodeBuildStep

**Version:** 1.0.0  
**Category:** quality  
**Plugin Type:** CodeBuildStep  
**Compute:** SMALL  
**Timeout:** 10 minutes  
**Failure Behavior:** fail  

## Keywords

`checkstyle`, `java`, `lint`, `code-style`, `google`, `sun`, `code-quality`

## Requirements

- Java 17.0.13-tem

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `CHECKSTYLE_VERSION` | `10.21.1` | Checkstyle Version |
| `CHECKSTYLE_CONFIG` | `google` | Checkstyle Config |
| `JAVA_VERSION` | `17.0.13-tem` | Java SDK version to use |

## Output

Primary output directory: `checkstyle-reports`

## Usage

This plugin runs as an AWS CDK `CodeBuildStep` within the Pipeline Builder platform. Add it as a step in your pipeline configuration:

```json
{
  "name": "checkstyle",
  "plugin": "checkstyle",
  "env": {
    "CHECKSTYLE_VERSION": "10.21.1",
    "CHECKSTYLE_CONFIG": "google",
    "JAVA_VERSION": "17.0.13-tem"
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
