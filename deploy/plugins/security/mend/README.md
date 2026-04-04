# mend

Mend (formerly WhiteSource) SCA plugin for scanning dependencies for known CVEs and OSS license compliance using AWS CDK CodeBuildStep

**Version:** 1.0.0  
**Category:** security  
**Plugin Type:** CodeBuildStep  
**Compute:** SMALL  
**Timeout:** 30 minutes  
**Failure Behavior:** fail  

## Keywords

`sca`, `dependency-scan`, `license`, `cve`

## Requirements

- 2 required secret(s) configured in AWS Secrets Manager (see [Secrets](#secrets) below)

## Secrets

| Name | Required | Description |
|------|----------|-------------|
| `MEND_API_KEY` | Yes | Mend API key |
| `MEND_ORG_TOKEN` | Yes | Mend organization token |

### Setting Up Secrets

Secrets are injected at build time via AWS CodeBuild environment variables backed by AWS Secrets Manager.

**Step 1: Store secrets in AWS Secrets Manager**

```bash
aws secretsmanager create-secret --name "MEND_API_KEY" --secret-string "<your-value>"
aws secretsmanager create-secret --name "MEND_ORG_TOKEN" --secret-string "<your-value>"
```

**Step 2: Reference secrets in your pipeline configuration**

When configuring this plugin in your pipeline, map each secret to the corresponding AWS Secrets Manager ARN:

```json
{
  "secrets": {
    "MEND_API_KEY": "arn:aws:secretsmanager:<region>:<account>:secret:MEND_API_KEY",
    "MEND_ORG_TOKEN": "arn:aws:secretsmanager:<region>:<account>:secret:MEND_ORG_TOKEN"
  }
}
```

**Step 3: IAM permissions**

Ensure the CodeBuild service role has `secretsmanager:GetSecretValue` permission for the referenced secrets.

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `MEND_URL` | `https://saas.mend.io` | Mend Url |
| `MEND_PRODUCT_NAME` | _none_ | Mend Product Name |
| `MEND_PROJECT_NAME` | _none_ | Mend Project Name |
| `MEND_SCAN_TYPE` | `sca` | Mend Scan Type |
| `MEND_SEVERITY_THRESHOLD` | `medium` | Mend Severity Threshold |

## Output

Primary output directory: `mend-reports`

## Usage

This plugin runs as an AWS CDK `CodeBuildStep` within the Pipeline Builder platform. Add it as a step in your pipeline configuration:

```json
{
  "name": "mend",
  "plugin": "mend",
  "env": {
    "MEND_URL": "https://saas.mend.io",
    "MEND_PRODUCT_NAME": "<your-mend_product_name>",
    "MEND_PROJECT_NAME": "<your-mend_project_name>",
    "MEND_SCAN_TYPE": "sca",
    "MEND_SEVERITY_THRESHOLD": "medium"
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
