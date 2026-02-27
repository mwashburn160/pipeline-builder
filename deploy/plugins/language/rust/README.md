# rust

Rust plugin for building and testing Rust applications using Cargo with AWS CDK CodeBuildStep

**Version:** 1.0.0  
**Category:** language  
**Plugin Type:** CodeBuildStep  
**Compute:** MEDIUM  
**Timeout:** 15 minutes  
**Failure Behavior:** fail  

## Keywords

`rust`, `cargo`, `rustup`

## Requirements

- Rust stable

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `RUST_VERSION` | `stable` | Rust toolchain version |

## Output

Primary output directory: `**/*`

## Usage

This plugin runs as an AWS CDK `CodeBuildStep` within the Pipeline Builder platform. Add it as a step in your pipeline configuration:

```json
{
  "name": "rust",
  "plugin": "rust",
  "env": {
    "RUST_VERSION": "stable"
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
