# coverage-py

coverage.py code coverage plugin for measuring and enforcing test coverage thresholds in Python projects using AWS CDK CodeBuildStep

**Version:** 1.0.0  
**Category:** testing  
**Plugin Type:** CodeBuildStep  
**Compute:** SMALL  
**Timeout:** 20 minutes  
**Failure Behavior:** fail  

## Keywords

`python`, `coverage`, `threshold`, `reporting`

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `PYTHON_VERSION` | `3.14` | Python Version |
| `COVERAGE_THRESHOLD` | `75` | Coverage Threshold |

## Output

Primary output directory: `coverage-reports`

## Usage

This plugin runs as an AWS CDK `CodeBuildStep` within the Pipeline Builder platform. Add it as a step in your pipeline configuration:

```json
{
  "name": "coverage-py",
  "plugin": "coverage-py",
  "env": {
    "PYTHON_VERSION": "3.14",
    "COVERAGE_THRESHOLD": "75"
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
