# rustfmt

rustfmt formatting check plugin for verifying consistent Rust code formatting using AWS CDK CodeBuildStep

**Version:** 1.0.0  
**Category:** quality  
**Plugin Type:** CodeBuildStep  
**Compute:** SMALL  
**Timeout:** 10 minutes  
**Failure Behavior:** fail  

## Keywords

`rust`, `formatting`, `code-style`, `consistency`

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `RUST_VERSION` | `stable` | Rust Version |

## Output

Primary output directory: `fmt-reports`

## Usage

This plugin runs as an AWS CDK `CodeBuildStep` within the Pipeline Builder platform. Add it as a step in your pipeline configuration:

```json
{
  "name": "rustfmt",
  "plugin": "rustfmt",
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
