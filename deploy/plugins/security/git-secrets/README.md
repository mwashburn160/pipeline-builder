# git-secrets

Secret detection plugin using Gitleaks and TruffleHog to scan code repositories for leaked credentials, API keys, and sensitive data using AWS CDK CodeBuildStep

**Version:** 1.0.0  
**Category:** security  
**Plugin Type:** CodeBuildStep  
**Compute:** SMALL  
**Timeout:** 30 minutes  
**Failure Behavior:** fail  

## Keywords

`gitleaks`, `trufflehog`, `secret-detection`, `credentials`

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `GITLEAKS_VERSION` | `8.22.0` | Gitleaks Version |
| `SCAN_MODE` | `directory` | Scan Mode |
| `GITLEAKS_CONFIG` | _none_ | Gitleaks Config |
| `REPORT_FORMAT` | `json` | Output report format |

## Output

Primary output directory: `secrets-reports`

## Usage

This plugin runs as an AWS CDK `CodeBuildStep` within the Pipeline Builder platform. Add it as a step in your pipeline configuration:

```json
{
  "name": "git-secrets",
  "plugin": "git-secrets",
  "env": {
    "GITLEAKS_VERSION": "8.22.0",
    "SCAN_MODE": "directory",
    "GITLEAKS_CONFIG": "<your-gitleaks_config>",
    "REPORT_FORMAT": "json"
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
