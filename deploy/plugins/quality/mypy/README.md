# mypy

mypy static type checking plugin for verifying Python type annotations and detecting type errors using AWS CDK CodeBuildStep

**Version:** 1.0.0  
**Category:** quality  
**Plugin Type:** CodeBuildStep  
**Compute:** SMALL  
**Timeout:** 15 minutes  
**Failure Behavior:** fail  

## Keywords

`python`, `type-checking`, `static-analysis`, `types`

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `PYTHON_VERSION` | `3.14` | Python Version |
| `MYPY_CONFIG` | `` | Mypy Config |

## Output

Primary output directory: `mypy-reports`

## Usage

This plugin runs as an AWS CDK `CodeBuildStep` within the Pipeline Builder platform. Add it as a step in your pipeline configuration:

```json
{
  "name": "mypy",
  "plugin": "mypy",
  "env": {
    "PYTHON_VERSION": "3.14",
    "MYPY_CONFIG": ""
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
