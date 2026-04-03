# trivy-nodejs

Trivy security scanning plugin for Node.js vulnerability detection in dependencies, code, and configuration using AWS CDK with CodeBuildStep

**Version:** 1.0.0  
**Category:** security  
**Plugin Type:** CodeBuildStep  
**Compute:** SMALL
**Timeout:** 15 minutes  
**Failure Behavior:** fail  

## Keywords

`nodejs`, `container`, `vulnerability`, `dependency-scan`

## Requirements

- Node.js

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `TRIVY_VERSION` | `0.69.3` | Trivy Version |
| `TRIVY_SEVERITY` | `HIGH,CRITICAL` | Trivy Severity |
| `TRIVY_FORMAT` | `json` | Trivy Format |

## Output

Primary output directory: `trivy-reports`

## Usage

This plugin runs as an AWS CDK `CodeBuildStep` within the Pipeline Builder platform. Add it as a step in your pipeline configuration:

```json
{
  "name": "trivy-nodejs",
  "plugin": "trivy-nodejs",
  "env": {
    "TRIVY_VERSION": "0.69.3",
    "TRIVY_SEVERITY": "HIGH,CRITICAL",
    "TRIVY_FORMAT": "json"
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
