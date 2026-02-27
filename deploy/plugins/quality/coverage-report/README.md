# coverage-report

Code coverage aggregation plugin for collecting and validating test coverage across JavaScript, Python, Java, and Go projects using AWS CDK CodeBuildStep

**Version:** 1.0.0  
**Category:** quality  
**Plugin Type:** CodeBuildStep  
**Compute:** SMALL  
**Timeout:** 10 minutes  
**Failure Behavior:** fail  

## Keywords

`coverage`, `istanbul`, `nyc`, `jacoco`, `lcov`, `code-quality`, `testing`

## Requirements

- Node.js
- Python
- Java

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `COVERAGE_THRESHOLD` | `80` | Minimum code coverage percentage |
| `COVERAGE_FORMAT` | `text` | Coverage Format |

## Output

Primary output directory: `coverage-reports`

## Usage

This plugin runs as an AWS CDK `CodeBuildStep` within the Pipeline Builder platform. Add it as a step in your pipeline configuration:

```json
{
  "name": "coverage-report",
  "plugin": "coverage-report",
  "env": {
    "COVERAGE_THRESHOLD": "80",
    "COVERAGE_FORMAT": "text"
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
