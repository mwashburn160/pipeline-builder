# cypress

Cypress end-to-end testing plugin for running browser-based UI tests with video recording and screenshot capture using AWS CDK CodeBuildStep

**Version:** 1.0.0  
**Category:** testing  
**Plugin Type:** CodeBuildStep  
**Compute:** LARGE  
**Timeout:** 30 minutes  
**Failure Behavior:** fail  

## Keywords

`e2e`, `browser`, `ui-test`, `video`

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `NODE_VERSION` | `24` | Node Version |
| `CYPRESS_BROWSER` | `electron` | Cypress Browser |
| `CYPRESS_SPEC` | `` | Cypress Spec |
| `CYPRESS_RECORD_KEY` | `` | Cypress Record Key |

## Output

Primary output directory: `cypress-reports`

## Usage

This plugin runs as an AWS CDK `CodeBuildStep` within the Pipeline Builder platform. Add it as a step in your pipeline configuration:

```json
{
  "name": "cypress",
  "plugin": "cypress",
  "env": {
    "NODE_VERSION": "24",
    "CYPRESS_BROWSER": "electron",
    "CYPRESS_SPEC": "",
    "CYPRESS_RECORD_KEY": ""
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
