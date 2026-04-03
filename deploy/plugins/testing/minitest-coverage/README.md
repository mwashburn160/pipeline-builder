# minitest-coverage

Minitest with SimpleCov coverage reporting plugin for measuring Ruby test coverage with threshold enforcement using AWS CDK CodeBuildStep

**Version:** 1.0.0  
**Category:** testing  
**Plugin Type:** CodeBuildStep  
**Compute:** SMALL  
**Timeout:** 20 minutes  
**Failure Behavior:** fail  

## Keywords

`ruby`, `minitest`, `coverage`, `simplecov`

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `RUBY_VERSION` | `4.0.1` | Ruby Version |
| `COVERAGE_THRESHOLD` | `70` | Coverage Threshold |

## Output

Primary output directory: `coverage-reports`

## Usage

This plugin runs as an AWS CDK `CodeBuildStep` within the Pipeline Builder platform. Add it as a step in your pipeline configuration:

```json
{
  "name": "minitest-coverage",
  "plugin": "minitest-coverage",
  "env": {
    "RUBY_VERSION": "4.0.1",
    "COVERAGE_THRESHOLD": "70"
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
