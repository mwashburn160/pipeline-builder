# dependency-check

OWASP Dependency-Check software composition analysis (SCA) plugin for scanning project dependencies for known CVEs using AWS CDK CodeBuildStep

**Version:** 1.0.0  
**Category:** security  
**Plugin Type:** CodeBuildStep  
**Compute:** MEDIUM  
**Timeout:** 30 minutes  
**Failure Behavior:** fail  

## Keywords

`owasp`, `sca`, `dependency-scan`, `cve`

## Requirements

- Node.js
- Python
- Go
- .NET SDK
- 1 optional secret(s) for additional features (see [Secrets](#secrets) below)

## Secrets

| Name | Required | Description |
|------|----------|-------------|
| `NVD_API_KEY` | No | NVD API key for enhanced vulnerability data |

### Setting Up Secrets

Secrets are injected at build time via AWS CodeBuild environment variables backed by AWS Secrets Manager.

**Step 1: Store secrets in AWS Secrets Manager**

```bash
aws secretsmanager create-secret --name "NVD_API_KEY" --secret-string "<your-value>"
```

**Step 2: Reference secrets in your pipeline configuration**

When configuring this plugin in your pipeline, map each secret to the corresponding AWS Secrets Manager ARN:

```json
{
  "secrets": {
    "NVD_API_KEY": "arn:aws:secretsmanager:<region>:<account>:secret:NVD_API_KEY"
  }
}
```

**Step 3: IAM permissions**

Ensure the CodeBuild service role has `secretsmanager:GetSecretValue` permission for the referenced secrets.

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `DC_VERSION` | `12.0.0` | Dc Version |
| `DC_FAIL_ON_CVSS` | `7` | Dc Fail On Cvss |
| `DC_FORMAT` | `JSON` | Dc Format |
| `DC_SUPPRESSION_FILE` | _none_ | Dc Suppression File |

## Output

Primary output directory: `dc-reports`

## Usage

This plugin runs as an AWS CDK `CodeBuildStep` within the Pipeline Builder platform. Add it as a step in your pipeline configuration:

```json
{
  "name": "dependency-check",
  "plugin": "dependency-check",
  "env": {
    "DC_VERSION": "12.0.0",
    "DC_FAIL_ON_CVSS": "7",
    "DC_FORMAT": "JSON",
    "DC_SUPPRESSION_FILE": "<your-dc_suppression_file>"
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
