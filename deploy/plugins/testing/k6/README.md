# k6

k6 performance and load testing plugin for running configurable load tests with virtual users, duration controls, and performance thresholds using AWS CDK CodeBuildStep

**Version:** 1.0.0  
**Category:** testing  
**Plugin Type:** CodeBuildStep  
**Compute:** MEDIUM  
**Timeout:** 60 minutes  
**Failure Behavior:** fail  

## Keywords

`k6`, `load-testing`, `performance`, `stress-test`, `grafana`, `api`, `benchmark`

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `K6_VERSION` | `0.56.0` | K6 Version |
| `K6_SCRIPT` | _none_ | K6 test script path |
| `K6_VUS` | `10` | K6 Vus |
| `K6_DURATION` | `30s` | K6 Duration |
| `K6_THRESHOLDS` | _none_ | K6 performance thresholds |

## Output

Primary output directory: `k6-reports`

## Usage

This plugin runs as an AWS CDK `CodeBuildStep` within the Pipeline Builder platform. Add it as a step in your pipeline configuration:

```json
{
  "name": "k6",
  "plugin": "k6",
  "env": {
    "K6_VERSION": "0.56.0",
    "K6_SCRIPT": "<your-k6_script>",
    "K6_VUS": "10",
    "K6_DURATION": "30s",
    "K6_THRESHOLDS": "<your-k6_thresholds>"
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
