# cargo-audit

Cargo audit plugin for scanning Rust crate dependencies for known security vulnerabilities using AWS CDK CodeBuildStep

**Version:** 1.0.0  
**Category:** security  
**Plugin Type:** CodeBuildStep  
**Compute:** SMALL  
**Timeout:** 10 minutes  
**Failure Behavior:** fail  

## Keywords

`rust`, `crate`, `dependency-scan`, `cve`

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `RUST_VERSION` | `stable` | Rust Version |

## Output

Primary output directory: `audit-reports`

## Usage

This plugin runs as an AWS CDK `CodeBuildStep` within the Pipeline Builder platform. Add it as a step in your pipeline configuration:

```json
{
  "name": "cargo-audit",
  "plugin": "cargo-audit",
  "env": {
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
