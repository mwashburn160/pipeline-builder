# ruff

Ruff Python linter and formatter plugin for enforcing code quality and consistent formatting using AWS CDK CodeBuildStep

**Version:** 1.0.0  
**Category:** quality  
**Plugin Type:** CodeBuildStep  
**Compute:** SMALL  
**Timeout:** 10 minutes  
**Failure Behavior:** fail  

## Keywords

`python`, `linter`, `formatter`, `code-quality`

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `PYTHON_VERSION` | `3.14` | Python Version |
| `RUFF_CONFIG` | `pyproject.toml` | Ruff Config |

## Output

Primary output directory: `lint-reports`

## Usage

This plugin runs as an AWS CDK `CodeBuildStep` within the Pipeline Builder platform. Add it as a step in your pipeline configuration:

```json
{
  "name": "ruff",
  "plugin": "ruff",
  "env": {
    "PYTHON_VERSION": "3.14",
    "RUFF_CONFIG": "pyproject.toml"
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
