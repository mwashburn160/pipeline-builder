# k6

k6 performance and load testing plugin for running configurable load tests with virtual users, duration controls, and performance thresholds using AWS CDK CodeBuildStep

**Version:** 1.0.0  
**Category:** testing  
**Plugin Type:** CodeBuildStep  
**Compute:** MEDIUM  
**Timeout:** 60 minutes  
**Failure Behavior:** fail  

## Keywords

`load-test`, `performance`, `virtual-users`, `threshold`

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `K6_VERSION` | `0.56.0` | k6 binary version to use |
| `K6_SCRIPT` | _none_ | Path to the k6 test script (auto-detected if not set) |
| `K6_VUS` | `10` | Number of virtual users to simulate |
| `K6_DURATION` | `30s` | Duration of the load test (e.g., 30s, 5m) |
| `K6_THRESHOLDS` | _none_ | Custom performance thresholds |

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
| `plugin-spec.yaml` | Plugin configuration and build commands |
| `Dockerfile` | Container image definition |
| `plugin.zip` | Packaged plugin archive |
| `README.md` | This documentation file |
