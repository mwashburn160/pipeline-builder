# postman

Postman API testing plugin using Newman CLI to run collection-based API contract tests with HTML and JUnit reporting using AWS CDK CodeBuildStep

**Version:** 1.0.0  
**Category:** testing  
**Plugin Type:** CodeBuildStep  
**Compute:** SMALL  
**Timeout:** 30 minutes  
**Failure Behavior:** fail  

## Keywords

`postman`, `newman`, `api`, `testing`, `contract`, `integration`, `rest`

## Requirements

- Node.js

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `COLLECTION_FILE` | _none_ | Collection File |
| `ENVIRONMENT_FILE` | _none_ | Environment File |
| `GLOBALS_FILE` | _none_ | Globals File |
| `ITERATION_COUNT` | `1` | Iteration Count |
| `NEWMAN_TIMEOUT` | `60000` | Newman Timeout |
| `BAIL_ON_FAILURE` | `false` | Bail On Failure |

## Output

Primary output directory: `postman-reports`

## Usage

This plugin runs as an AWS CDK `CodeBuildStep` within the Pipeline Builder platform. Add it as a step in your pipeline configuration:

```json
{
  "name": "postman",
  "plugin": "postman",
  "env": {
    "COLLECTION_FILE": "<your-collection_file>",
    "ENVIRONMENT_FILE": "<your-environment_file>",
    "GLOBALS_FILE": "<your-globals_file>",
    "ITERATION_COUNT": "1",
    "NEWMAN_TIMEOUT": "60000",
    "BAIL_ON_FAILURE": "false"
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
