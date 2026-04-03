# clippy

Clippy linting plugin for catching common mistakes and enforcing idiomatic Rust patterns using AWS CDK CodeBuildStep

**Version:** 1.0.0  
**Category:** quality  
**Plugin Type:** CodeBuildStep  
**Compute:** SMALL  
**Timeout:** 15 minutes  
**Failure Behavior:** fail  

## Keywords

`rust`, `linter`, `static-analysis`, `idioms`

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `RUST_VERSION` | `stable` | Rust Version |
| `CLIPPY_FLAGS` | `-D warnings` | Clippy Flags |

## Output

Primary output directory: `lint-reports`

## Usage

This plugin runs as an AWS CDK `CodeBuildStep` within the Pipeline Builder platform. Add it as a step in your pipeline configuration:

```json
{
  "name": "clippy",
  "plugin": "clippy",
  "env": {
    "RUST_VERSION": "stable",
    "CLIPPY_FLAGS": "-D warnings"
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
