# postman

Postman API testing plugin using Newman CLI to run collection-based API contract tests with HTML and JUnit reporting using AWS CDK CodeBuildStep

**Version:** 1.0.0  
**Category:** testing  
**Plugin Type:** CodeBuildStep  
**Compute:** SMALL  
**Timeout:** 30 minutes  
**Failure Behavior:** fail  

## Keywords

`api-test`, `newman`, `contract-test`, `collection`

## Requirements

- Node.js 24

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `COLLECTION_FILE` | _none_ | Path to the Postman collection JSON file (auto-detected if not set) |
| `ENVIRONMENT_FILE` | _none_ | Path to Postman environment file |
| `GLOBALS_FILE` | _none_ | Path to Postman globals file |
| `ITERATION_COUNT` | `1` | Number of times to run the collection |
| `NEWMAN_TIMEOUT` | `60000` | Request timeout in milliseconds |
| `BAIL_ON_FAILURE` | `false` | Stop the run on first test failure |

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
| `plugin-spec.yaml` | Plugin configuration and build commands |
| `Dockerfile` | Container image definition |
| `plugin.zip` | Packaged plugin archive |
| `README.md` | This documentation file |
