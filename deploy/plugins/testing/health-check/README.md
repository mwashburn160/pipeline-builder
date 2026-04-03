# health-check

Post-deployment health check and smoke testing plugin for verifying application endpoints are responsive and returning expected status codes using AWS CDK CodeBuildStep

**Version:** 1.0.0  
**Category:** testing  
**Plugin Type:** CodeBuildStep  
**Compute:** SMALL  
**Timeout:** 30 minutes  
**Failure Behavior:** fail  

## Keywords

`smoke-test`, `endpoint`, `http`, `post-deploy`

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `HEALTH_ENDPOINTS` | _none_ | Comma-separated list of URLs to check |
| `HEALTH_TIMEOUT` | `10` | Maximum seconds to wait per request |
| `HEALTH_RETRIES` | `3` | Number of retry attempts per endpoint |
| `HEALTH_RETRY_DELAY` | `5` | Seconds to wait between retries |
| `EXPECTED_STATUS` | `200` | HTTP status code that indicates a healthy endpoint |

## Output

Primary output directory: `health-reports`

## Usage

This plugin runs as an AWS CDK `CodeBuildStep` within the Pipeline Builder platform. Add it as a step in your pipeline configuration:

```json
{
  "name": "health-check",
  "plugin": "health-check",
  "env": {
    "HEALTH_ENDPOINTS": "<your-health_endpoints>",
    "HEALTH_TIMEOUT": "10",
    "HEALTH_RETRIES": "3",
    "HEALTH_RETRY_DELAY": "5",
    "EXPECTED_STATUS": "200"
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
