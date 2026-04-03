# brakeman

Brakeman static security analysis plugin for detecting vulnerabilities in Ruby on Rails applications using AWS CDK CodeBuildStep

**Version:** 1.0.0  
**Category:** security  
**Plugin Type:** CodeBuildStep  
**Compute:** SMALL  
**Timeout:** 15 minutes  
**Failure Behavior:** fail  

## Keywords

`ruby`, `rails`, `sast`, `vulnerability`

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `RUBY_VERSION` | `4.0.1` | Ruby Version |
| `BRAKEMAN_CONFIDENCE` | `2` | Brakeman Confidence |

## Output

Primary output directory: `security-reports`

## Usage

This plugin runs as an AWS CDK `CodeBuildStep` within the Pipeline Builder platform. Add it as a step in your pipeline configuration:

```json
{
  "name": "brakeman",
  "plugin": "brakeman",
  "env": {
    "RUBY_VERSION": "4.0.1",
    "BRAKEMAN_CONFIDENCE": "2"
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
