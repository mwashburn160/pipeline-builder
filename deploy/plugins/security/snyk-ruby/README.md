# snyk-ruby

Snyk security scanning for Ruby projects using AWS CDK with CodeBuildStep

**Version:** 1.0.0  
**Category:** security  
**Plugin Type:** CodeBuildStep  
**Compute:** SMALL  
**Timeout:** 15 minutes  
**Failure Behavior:** fail  

## Keywords

`ruby`, `sca`, `vulnerability`, `dependency-scan`

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `SNYK_SEVERITY_THRESHOLD` | `high` | Snyk Severity Threshold |
| `RUBY_VERSION` | `4.0.1` | Ruby Version |

## Output

Primary output directory: `snyk-reports`

## Usage

This plugin runs as an AWS CDK `CodeBuildStep` within the Pipeline Builder platform. Add it as a step in your pipeline configuration:

```json
{
  "name": "snyk-ruby",
  "plugin": "snyk-ruby",
  "env": {
    "SNYK_SEVERITY_THRESHOLD": "high",
    "RUBY_VERSION": "4.0.1"
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
