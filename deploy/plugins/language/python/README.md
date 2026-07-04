# python

Python plugin for building and testing Python applications using pip, Poetry, or Pipenv with AWS CDK CodeBuildStep

**Version:** 1.0.0  
**Category:** language  
**Plugin Type:** CodeBuildStep  
**Compute:** MEDIUM  
**Timeout:** 15 minutes  
**Failure Behavior:** fail  

## Keywords

`python`, `pip`, `poetry`, `pipenv`

## Requirements

- Python 3.14

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `PACKAGE_MANAGER` | `auto` | Package manager (auto, pip, poetry, pipenv) |

## Output

Primary output directory: `**/*`

## Usage

This plugin runs as an AWS CDK `CodeBuildStep` within the Pipeline Builder platform. Add it as a step in your pipeline configuration:

```json
{
  "name": "python",
  "plugin": "python",
  "env": {
    "PACKAGE_MANAGER": "auto"
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
