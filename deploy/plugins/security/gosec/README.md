# gosec

gosec security checker plugin for scanning Go source code for security vulnerabilities and coding issues using AWS CDK CodeBuildStep

**Version:** 1.0.0  
**Category:** security  
**Plugin Type:** CodeBuildStep  
**Compute:** SMALL  
**Timeout:** 15 minutes  
**Failure Behavior:** fail  

## Keywords

`go`, `sast`, `vulnerability`, `security-linter`

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `GO_VERSION` | `1.24.13` | Go Version |

## Output

Primary output directory: `security-reports`

## Usage

This plugin runs as an AWS CDK `CodeBuildStep` within the Pipeline Builder platform. Add it as a step in your pipeline configuration:

```json
{
  "name": "gosec",
  "plugin": "gosec",
  "env": {
    "GO_VERSION": "1.24.13"
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
