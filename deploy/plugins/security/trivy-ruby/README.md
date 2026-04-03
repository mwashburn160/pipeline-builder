# trivy-ruby

Trivy security scanning for Ruby projects using AWS CDK with CodeBuildStep

**Version:** 1.0.0  
**Category:** security  
**Plugin Type:** CodeBuildStep  
**Compute:** SMALL  
**Timeout:** 15 minutes  
**Failure Behavior:** fail  

## Keywords

`ruby`, `vulnerability`, `dependency-scan`, `cve`

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `TRIVY_VERSION` | `0.69.3` | Trivy Version |
| `TRIVY_SEVERITY` | `HIGH,CRITICAL` | Trivy Severity |
| `TRIVY_FORMAT` | `json` | Trivy Format |
| `RUBY_VERSION` | `4.0.1` | Ruby Version |

## Output

Primary output directory: `trivy-reports`

## Usage

This plugin runs as an AWS CDK `CodeBuildStep` within the Pipeline Builder platform. Add it as a step in your pipeline configuration:

```json
{
  "name": "trivy-ruby",
  "plugin": "trivy-ruby",
  "env": {
    "TRIVY_VERSION": "0.69.3",
    "TRIVY_SEVERITY": "HIGH,CRITICAL",
    "TRIVY_FORMAT": "json",
    "RUBY_VERSION": "4.0.1"
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
