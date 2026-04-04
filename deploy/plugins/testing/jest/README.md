# jest

Jest testing framework plugin for running JavaScript and TypeScript unit tests with coverage reporting using AWS CDK CodeBuildStep

**Version:** 1.0.0  
**Category:** testing  
**Plugin Type:** CodeBuildStep  
**Compute:** SMALL  
**Timeout:** 20 minutes  
**Failure Behavior:** fail  

## Keywords

`javascript`, `typescript`, `unit-test`, `coverage`

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `NODE_VERSION` | `24` | Node Version |
| `JEST_CONFIG` | `` | Jest Config |
| `JEST_JUNIT_OUTPUT_DIR` | `test-reports` | Jest Junit Output Dir |

## Output

Primary output directory: `test-reports`

## Usage

This plugin runs as an AWS CDK `CodeBuildStep` within the Pipeline Builder platform. Add it as a step in your pipeline configuration:

```json
{
  "name": "jest",
  "plugin": "jest",
  "env": {
    "NODE_VERSION": "24",
    "JEST_CONFIG": "",
    "JEST_JUNIT_OUTPUT_DIR": "test-reports"
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
