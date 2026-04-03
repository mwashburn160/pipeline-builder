# nodejs-bundle

Node.js bundle and build plugin for compiling and bundling JavaScript and TypeScript projects using AWS CDK CodeBuildStep

**Version:** 1.0.0  
**Category:** artifact  
**Plugin Type:** CodeBuildStep  
**Compute:** MEDIUM  
**Timeout:** 20 minutes  
**Failure Behavior:** fail  

## Keywords

`nodejs`, `javascript`, `typescript`, `bundle`

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `NODE_VERSION` | `24` | Node Version |
| `BUILD_SCRIPT` | `build` | Build Script |

## Output

Primary output directory: `build-output`

## Usage

This plugin runs as an AWS CDK `CodeBuildStep` within the Pipeline Builder platform. Add it as a step in your pipeline configuration:

```json
{
  "name": "nodejs-bundle",
  "plugin": "nodejs-bundle",
  "env": {
    "NODE_VERSION": "24",
    "BUILD_SCRIPT": "build"
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
