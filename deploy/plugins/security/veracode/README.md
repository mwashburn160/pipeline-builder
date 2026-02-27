# veracode

Veracode enterprise SAST and DAST security scanning plugin for static analysis of application artifacts using AWS CDK CodeBuildStep

**Version:** 1.0.0  
**Category:** security  
**Plugin Type:** CodeBuildStep  
**Compute:** MEDIUM  
**Timeout:** 30 minutes  
**Failure Behavior:** fail  

## Keywords

`veracode`, `sast`, `dast`, `security`, `enterprise`, `compliance`, `vulnerability`

## Requirements

- Python
- Java
- 2 required secret(s) configured in AWS Secrets Manager (see [Secrets](#secrets) below)

## Secrets

| Name | Required | Description |
|------|----------|-------------|
| `VERACODE_API_ID` | Yes | Veracode API ID |
| `VERACODE_API_KEY` | Yes | Veracode API key |

### Setting Up Secrets

Secrets are injected at build time via AWS CodeBuild environment variables backed by AWS Secrets Manager.

**Step 1: Store secrets in AWS Secrets Manager**

```bash
aws secretsmanager create-secret --name "VERACODE_API_ID" --secret-string "<your-value>"
aws secretsmanager create-secret --name "VERACODE_API_KEY" --secret-string "<your-value>"
```

**Step 2: Reference secrets in your pipeline configuration**

When configuring this plugin in your pipeline, map each secret to the corresponding AWS Secrets Manager ARN:

```json
{
  "secrets": {
    "VERACODE_API_ID": "arn:aws:secretsmanager:<region>:<account>:secret:VERACODE_API_ID",
    "VERACODE_API_KEY": "arn:aws:secretsmanager:<region>:<account>:secret:VERACODE_API_KEY"
  }
}
```

**Step 3: IAM permissions**

Ensure the CodeBuild service role has `secretsmanager:GetSecretValue` permission for the referenced secrets.

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `VERACODE_SCAN_TYPE` | `pipeline` | Veracode Scan Type |
| `VERACODE_APP_NAME` | _none_ | Veracode App Name |
| `VERACODE_SEVERITY_THRESHOLD` | `Medium` | Veracode Severity Threshold |
| `VERACODE_ARTIFACT` | _none_ | Veracode Artifact |

## Output

Primary output directory: `veracode-reports`

## Usage

This plugin runs as an AWS CDK `CodeBuildStep` within the Pipeline Builder platform. Add it as a step in your pipeline configuration:

```json
{
  "name": "veracode",
  "plugin": "veracode",
  "env": {
    "VERACODE_SCAN_TYPE": "pipeline",
    "VERACODE_APP_NAME": "<your-veracode_app_name>",
    "VERACODE_SEVERITY_THRESHOLD": "Medium",
    "VERACODE_ARTIFACT": "<your-veracode_artifact>"
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
