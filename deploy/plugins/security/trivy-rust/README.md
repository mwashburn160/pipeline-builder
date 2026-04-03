# trivy-rust

Trivy security scanning for Rust projects using AWS CDK with CodeBuildStep

**Version:** 1.0.0  
**Category:** security  
**Plugin Type:** CodeBuildStep  
**Compute:** SMALL  
**Timeout:** 15 minutes  
**Failure Behavior:** fail  

## Keywords

`rust`, `vulnerability`, `dependency-scan`, `cve`

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `TRIVY_VERSION` | `0.69.3` | Trivy Version |
| `TRIVY_SEVERITY` | `HIGH,CRITICAL` | Trivy Severity |
| `TRIVY_FORMAT` | `json` | Trivy Format |
| `RUST_VERSION` | `stable` | Rust Version |

## Output

Primary output directory: `trivy-reports`

## Usage

This plugin runs as an AWS CDK `CodeBuildStep` within the Pipeline Builder platform. Add it as a step in your pipeline configuration:

```json
{
  "name": "trivy-rust",
  "plugin": "trivy-rust",
  "env": {
    "TRIVY_VERSION": "0.69.3",
    "TRIVY_SEVERITY": "HIGH,CRITICAL",
    "TRIVY_FORMAT": "json",
    "RUST_VERSION": "stable"
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
