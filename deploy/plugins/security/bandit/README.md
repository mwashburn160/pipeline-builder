# bandit

Bandit security linter plugin for finding common security vulnerabilities in Python code using AWS CDK CodeBuildStep

**Version:** 1.0.0  
**Category:** security  
**Plugin Type:** CodeBuildStep  
**Compute:** SMALL  
**Timeout:** 10 minutes  
**Failure Behavior:** fail  

## Keywords

`python`, `sast`, `vulnerability`, `security-linter`

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `PYTHON_VERSION` | `3.14` | Python Version |
| `BANDIT_SEVERITY` | `medium` | Bandit Severity |
| `BANDIT_CONFIDENCE` | `medium` | Bandit Confidence |

## Output

Primary output directory: `security-reports`

## Usage

This plugin runs as an AWS CDK `CodeBuildStep` within the Pipeline Builder platform. Add it as a step in your pipeline configuration:

```json
{
  "name": "bandit",
  "plugin": "bandit",
  "env": {
    "PYTHON_VERSION": "3.14",
    "BANDIT_SEVERITY": "medium",
    "BANDIT_CONFIDENCE": "medium"
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
