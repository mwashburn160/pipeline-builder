# license-checker

OSS license compliance scanning plugin to detect restricted or incompatible licenses in project dependencies using AWS CDK CodeBuildStep

**Version:** 1.0.0  
**Category:** security  
**Plugin Type:** CodeBuildStep  
**Compute:** SMALL  
**Timeout:** 30 minutes  
**Failure Behavior:** fail  

## Keywords

`license`, `compliance`, `oss`, `dependency-scan`

## Requirements

- Node.js
- Python
- Ruby

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `LICENSE_DENY` | _none_ | Comma-separated licences that FAIL the build. Enforced for Node and Python only; the Ruby scan is report-only (`license_finder` takes its allow/deny from a decisions file, not a CLI flag). |
| `LICENSE_ALLOW` | _none_ | License Allow |
| `REPORT_FORMAT` | `json` | Output report format |

## Output

Primary output directory: `license-reports`

## Usage

This plugin runs as an AWS CDK `CodeBuildStep` within the Pipeline Builder platform. Add it as a step in your pipeline configuration:

```json
{
  "name": "license-checker",
  "plugin": "license-checker",
  "env": {
    "LICENSE_DENY": "<your-license_deny>",
    "LICENSE_ALLOW": "<your-license_allow>",
    "REPORT_FORMAT": "json"
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
