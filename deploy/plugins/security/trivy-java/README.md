# trivy-java

Trivy security scanning for Java/Kotlin projects using AWS CDK with CodeBuildStep

**Version:** 1.0.0  
**Category:** security  
**Plugin Type:** CodeBuildStep  
**Compute:** SMALL  
**Timeout:** 15 minutes  
**Failure Behavior:** fail  

## Keywords

`java`, `vulnerability`, `dependency-scan`, `cve`

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `TRIVY_VERSION` | `0.69.3` | Trivy Version |
| `TRIVY_SEVERITY` | `HIGH,CRITICAL` | Trivy Severity |
| `TRIVY_FORMAT` | `json` | Trivy Format |
| `JAVA_VERSION` | `21.0.10-tem` | Java Version |

## Output

Primary output directory: `trivy-reports`

## Usage

This plugin runs as an AWS CDK `CodeBuildStep` within the Pipeline Builder platform. Add it as a step in your pipeline configuration:

```json
{
  "name": "trivy-java",
  "plugin": "trivy-java",
  "env": {
    "TRIVY_VERSION": "0.69.3",
    "TRIVY_SEVERITY": "HIGH,CRITICAL",
    "TRIVY_FORMAT": "json",
    "JAVA_VERSION": "21.0.10-tem"
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
