# python-pytest

pytest testing framework plugin for running Python unit and integration tests with JUnit reporting using AWS CDK CodeBuildStep

**Version:** 1.0.0  
**Category:** testing  
**Plugin Type:** CodeBuildStep  
**Compute:** SMALL  
**Timeout:** 20 minutes  
**Failure Behavior:** fail  

## Keywords

`python`, `pytest`, `unit-test`, `junit`

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `PYTHON_VERSION` | `3.14` | Python Version |
| `PYTEST_ARGS` | `-x --tb=short` | Pytest Args |

## Output

Primary output directory: `test-reports`

## Usage

This plugin runs as an AWS CDK `CodeBuildStep` within the Pipeline Builder platform. Add it as a step in your pipeline configuration:

```json
{
  "name": "python-pytest",
  "plugin": "python-pytest",
  "env": {
    "PYTHON_VERSION": "3.14",
    "PYTEST_ARGS": "-x --tb=short"
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
