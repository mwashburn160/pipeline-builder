# jacoco

JaCoCo code coverage plugin for measuring and enforcing test coverage thresholds in Java projects using AWS CDK CodeBuildStep

**Version:** 1.0.0  
**Category:** quality  
**Plugin Type:** CodeBuildStep  
**Compute:** SMALL  
**Timeout:** 20 minutes  
**Failure Behavior:** fail  

## Keywords

`java`, `coverage`, `threshold`, `reporting`

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `JAVA_VERSION` | `17` | Java Version |
| `COVERAGE_THRESHOLD` | `70` | Coverage Threshold |

## Output

Primary output directory: `coverage-reports`

## Usage

This plugin runs as an AWS CDK `CodeBuildStep` within the Pipeline Builder platform. Add it as a step in your pipeline configuration:

```json
{
  "name": "jacoco",
  "plugin": "jacoco",
  "env": {
    "JAVA_VERSION": "17",
    "COVERAGE_THRESHOLD": "70"
  }
}
```

## Files

| File | Description |
|------|-------------|
| `spec.yaml` | Plugin configuration and build commands |
| `Dockerfile` | Container image definition |
| `plugin.zip` | Packaged plugin archive |
| `README.md` | This documentation file |
