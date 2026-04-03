# artillery

Artillery load testing plugin for running HTTP and WebSocket performance tests with configurable scenarios and reporting using AWS CDK CodeBuildStep

**Version:** 1.0.0  
**Category:** testing  
**Plugin Type:** CodeBuildStep  
**Compute:** MEDIUM  
**Timeout:** 60 minutes  
**Failure Behavior:** fail  

## Keywords

`load-test`, `performance`, `http`, `websocket`

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `NODE_VERSION` | `24` | Node Version |
| `ARTILLERY_CONFIG` | `` | Artillery Config |
| `ARTILLERY_TARGET` | `` | Artillery Target |

## Output

Primary output directory: `artillery-reports`

## Usage

This plugin runs as an AWS CDK `CodeBuildStep` within the Pipeline Builder platform. Add it as a step in your pipeline configuration:

```json
{
  "name": "artillery",
  "plugin": "artillery",
  "env": {
    "NODE_VERSION": "24",
    "ARTILLERY_CONFIG": "",
    "ARTILLERY_TARGET": ""
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
