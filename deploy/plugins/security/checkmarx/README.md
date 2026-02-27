# checkmarx

Checkmarx enterprise SAST and KICS infrastructure-as-code scanning plugin for detecting vulnerabilities in application code and IaC templates using AWS CDK CodeBuildStep

**Version:** 1.0.0  
**Category:** security  
**Plugin Type:** CodeBuildStep  
**Compute:** MEDIUM  
**Timeout:** 30 minutes  
**Failure Behavior:** fail  

## Keywords

`checkmarx`, `sast`, `kics`, `iac`, `security`, `enterprise`, `compliance`

## Requirements

- 1 required secret(s) configured in AWS Secrets Manager (see [Secrets](#secrets) below)

## Secrets

| Name | Required | Description |
|------|----------|-------------|
| `CX_CLIENT_SECRET` | Yes | Checkmarx client secret |

### Setting Up Secrets

Secrets are injected at build time via AWS CodeBuild environment variables backed by AWS Secrets Manager.

**Step 1: Store secrets in AWS Secrets Manager**

```bash
aws secretsmanager create-secret --name "CX_CLIENT_SECRET" --secret-string "<your-value>"
```

**Step 2: Reference secrets in your pipeline configuration**

When configuring this plugin in your pipeline, map each secret to the corresponding AWS Secrets Manager ARN:

```json
{
  "secrets": {
    "CX_CLIENT_SECRET": "arn:aws:secretsmanager:<region>:<account>:secret:CX_CLIENT_SECRET"
  }
}
```

**Step 3: IAM permissions**

Ensure the CodeBuild service role has `secretsmanager:GetSecretValue` permission for the referenced secrets.

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `CX_BASE_URI` | `https://ast.checkmarx.net` | Cx Base Uri |
| `CX_TENANT` | _none_ | Cx Tenant |
| `CX_PROJECT_NAME` | _none_ | Cx Project Name |
| `CX_SCAN_TYPE` | `sast` | Cx Scan Type |
| `CX_SEVERITY_THRESHOLD` | `high` | Cx Severity Threshold |

## Output

Primary output directory: `checkmarx-reports`

## Usage

This plugin runs as an AWS CDK `CodeBuildStep` within the Pipeline Builder platform. Add it as a step in your pipeline configuration:

```json
{
  "name": "checkmarx",
  "plugin": "checkmarx",
  "env": {
    "CX_BASE_URI": "https://ast.checkmarx.net",
    "CX_TENANT": "<your-cx_tenant>",
    "CX_PROJECT_NAME": "<your-cx_project_name>",
    "CX_SCAN_TYPE": "sast",
    "CX_SEVERITY_THRESHOLD": "high"
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
