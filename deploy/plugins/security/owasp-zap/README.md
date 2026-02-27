# owasp-zap

OWASP ZAP dynamic application security testing (DAST) plugin for scanning web applications and APIs for runtime vulnerabilities using AWS CDK CodeBuildStep

**Version:** 1.0.0  
**Category:** security  
**Plugin Type:** CodeBuildStep  
**Compute:** MEDIUM  
**Timeout:** 30 minutes  
**Failure Behavior:** fail  

## Keywords

`owasp`, `zap`, `dast`, `security`, `vulnerability`, `web`, `api`, `penetration-testing`

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `ZAP_VERSION` | `2.16.0` | Zap Version |
| `ZAP_SCAN_TYPE` | `baseline` | Zap Scan Type |
| `ZAP_TARGET_URL` | _none_ | Zap Target Url |
| `ZAP_RULES_CONFIG` | _none_ | Zap Rules Config |
| `ZAP_FORMAT` | `json` | Zap Format |

## Output

Primary output directory: `zap-reports`

## Usage

This plugin runs as an AWS CDK `CodeBuildStep` within the Pipeline Builder platform. Add it as a step in your pipeline configuration:

```json
{
  "name": "owasp-zap",
  "plugin": "owasp-zap",
  "env": {
    "ZAP_VERSION": "2.16.0",
    "ZAP_SCAN_TYPE": "baseline",
    "ZAP_TARGET_URL": "<your-zap_target_url>",
    "ZAP_RULES_CONFIG": "<your-zap_rules_config>",
    "ZAP_FORMAT": "json"
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
