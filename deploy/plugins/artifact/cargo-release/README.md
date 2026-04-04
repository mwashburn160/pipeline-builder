# cargo-release

Cargo release binary build plugin for compiling optimized Rust binaries with cross-compilation support using AWS CDK CodeBuildStep

**Version:** 1.0.0  
**Category:** artifact  
**Plugin Type:** CodeBuildStep  
**Compute:** MEDIUM  
**Timeout:** 30 minutes  
**Failure Behavior:** fail  

## Keywords

`rust`, `binary`, `cross-compilation`, `release`

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `RUST_VERSION` | `stable` | Rust Version |
| `CARGO_PROFILE` | `release` | Cargo Profile |
| `TARGET` | `x86_64-unknown-linux-gnu` | Target |

## Output

Primary output directory: `target/release`

## Usage

This plugin runs as an AWS CDK `CodeBuildStep` within the Pipeline Builder platform. Add it as a step in your pipeline configuration:

```json
{
  "name": "cargo-release",
  "plugin": "cargo-release",
  "env": {
    "RUST_VERSION": "stable",
    "CARGO_PROFILE": "release",
    "TARGET": "x86_64-unknown-linux-gnu"
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
