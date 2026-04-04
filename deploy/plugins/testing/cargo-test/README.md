# cargo-test

Cargo test runner plugin for executing Rust unit and integration tests across workspace crates using AWS CDK CodeBuildStep

**Version:** 1.0.0  
**Category:** testing  
**Plugin Type:** CodeBuildStep  
**Compute:** MEDIUM  
**Timeout:** 30 minutes  
**Failure Behavior:** fail  

## Keywords

`rust`, `unit-test`, `integration-test`, `cargo`

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `RUST_VERSION` | `stable` | Rust Version |

## Output

Primary output directory: `test-reports`

## Usage

This plugin runs as an AWS CDK `CodeBuildStep` within the Pipeline Builder platform. Add it as a step in your pipeline configuration:

```json
{
  "name": "cargo-test",
  "plugin": "cargo-test",
  "env": {
    "RUST_VERSION": "stable"
  }
}
```

## Files

| File | Description |
|------|-------------|
| `plugin-spec.yaml` | Plugin configuration and build commands |
| `Dockerfile` | Container image definition |
| `plugin.zip` | Packaged plugin archive |
| `README.md` | This documentation file |
