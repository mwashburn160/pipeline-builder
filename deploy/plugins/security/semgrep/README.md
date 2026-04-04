# semgrep

Semgrep open-source SAST plugin for fast, lightweight static analysis across 30+ languages with custom rule support using AWS CDK CodeBuildStep

**Version:** 1.0.0  
**Category:** security  
**Plugin Type:** CodeBuildStep  
**Compute:** MEDIUM  
**Timeout:** 30 minutes  
**Failure Behavior:** fail  

## Keywords

`sast`, `multi-language`, `custom-rules`, `vulnerability`

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `SEMGREP_RULES` | `auto` | Semgrep Rules |
| `SEMGREP_SEVERITY` | `ERROR,WARNING` | Semgrep Severity |
| `SEMGREP_APP_TOKEN` | `` | Semgrep App Token |

## Output

Primary output directory: `semgrep-reports`

## Usage

This plugin runs as an AWS CDK `CodeBuildStep` within the Pipeline Builder platform. Add it as a step in your pipeline configuration:

```json
{
  "name": "semgrep",
  "plugin": "semgrep",
  "env": {
    "SEMGREP_RULES": "auto",
    "SEMGREP_SEVERITY": "ERROR,WARNING",
    "SEMGREP_APP_TOKEN": ""
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
