# typescript-check

TypeScript type checking plugin for verifying type correctness without emitting output using AWS CDK CodeBuildStep

**Version:** 1.0.0  
**Category:** quality  
**Plugin Type:** CodeBuildStep  
**Compute:** SMALL  
**Timeout:** 15 minutes  
**Failure Behavior:** fail  

## Keywords

`typescript`, `type-checking`, `static-analysis`, `types`

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `NODE_VERSION` | `24` | Node Version |
| `TSC_FLAGS` | `--noEmit` | Tsc Flags |

## Output

Primary output directory: `tsc-reports`

## Usage

This plugin runs as an AWS CDK `CodeBuildStep` within the Pipeline Builder platform. Add it as a step in your pipeline configuration:

```json
{
  "name": "typescript-check",
  "plugin": "typescript-check",
  "env": {
    "NODE_VERSION": "24",
    "TSC_FLAGS": "--noEmit"
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
