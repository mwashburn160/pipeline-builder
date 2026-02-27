# python

Python plugin for building and testing Python applications using pip, Poetry, or Pipenv with AWS CDK CodeBuildStep

**Version:** 1.0.0  
**Category:** language  
**Plugin Type:** CodeBuildStep  
**Compute:** MEDIUM  
**Timeout:** 15 minutes  
**Failure Behavior:** fail  

## Keywords

`python`, `pip`, `poetry`, `pipenv`, `pytest`

## Requirements

- Python 3.12

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `PYTHON_VERSION` | `3.12` | Python version to use |
| `PACKAGE_MANAGER` | `auto` | Package manager (auto, npm, yarn, pnpm, pip, poetry, etc.) |

## Output

Primary output directory: `**/*`

## Usage

This plugin runs as an AWS CDK `CodeBuildStep` within the Pipeline Builder platform. Add it as a step in your pipeline configuration:

```json
{
  "name": "python",
  "plugin": "python",
  "env": {
    "PYTHON_VERSION": "3.12",
    "PACKAGE_MANAGER": "auto"
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
