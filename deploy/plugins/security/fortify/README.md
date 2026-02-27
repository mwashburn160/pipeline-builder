# fortify

Micro Focus Fortify enterprise SAST plugin supporting Fortify on Demand (FoD) and ScanCentral for static code analysis using AWS CDK CodeBuildStep

**Version:** 1.0.0  
**Category:** security  
**Plugin Type:** CodeBuildStep  
**Compute:** MEDIUM  
**Timeout:** 30 minutes  
**Failure Behavior:** fail  

## Keywords

`fortify`, `sast`, `security`, `enterprise`, `micro-focus`, `fod`, `compliance`

## Requirements

- 3 optional secret(s) for additional features (see [Secrets](#secrets) below)

## Secrets

| Name | Required | Description |
|------|----------|-------------|
| `FORTIFY_SSC_TOKEN` | No | Fortify SSC authentication token |
| `FOD_CLIENT_ID` | No | Fortify on Demand client ID |
| `FOD_CLIENT_SECRET` | No | Fortify on Demand client secret |

### Setting Up Secrets

Secrets are injected at build time via AWS CodeBuild environment variables backed by AWS Secrets Manager.

**Step 1: Store secrets in AWS Secrets Manager**

```bash
aws secretsmanager create-secret --name "FORTIFY_SSC_TOKEN" --secret-string "<your-value>"
aws secretsmanager create-secret --name "FOD_CLIENT_ID" --secret-string "<your-value>"
aws secretsmanager create-secret --name "FOD_CLIENT_SECRET" --secret-string "<your-value>"
```

**Step 2: Reference secrets in your pipeline configuration**

When configuring this plugin in your pipeline, map each secret to the corresponding AWS Secrets Manager ARN:

```json
{
  "secrets": {
    "FORTIFY_SSC_TOKEN": "arn:aws:secretsmanager:<region>:<account>:secret:FORTIFY_SSC_TOKEN",
    "FOD_CLIENT_ID": "arn:aws:secretsmanager:<region>:<account>:secret:FOD_CLIENT_ID",
    "FOD_CLIENT_SECRET": "arn:aws:secretsmanager:<region>:<account>:secret:FOD_CLIENT_SECRET"
  }
}
```

**Step 3: IAM permissions**

Ensure the CodeBuild service role has `secretsmanager:GetSecretValue` permission for the referenced secrets.

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `FORTIFY_SCAN_TYPE` | `fod` | Fortify Scan Type |
| `FORTIFY_APP_NAME` | _none_ | Fortify App Name |
| `FORTIFY_RELEASE` | _none_ | Fortify Release |
| `FOD_URL` | `https://ams.fortify.com` | Fod Url |
| `SSC_URL` | _none_ | Ssc Url |

## Output

Primary output directory: `fortify-reports`

## Usage

This plugin runs as an AWS CDK `CodeBuildStep` within the Pipeline Builder platform. Add it as a step in your pipeline configuration:

```json
{
  "name": "fortify",
  "plugin": "fortify",
  "env": {
    "FORTIFY_SCAN_TYPE": "fod",
    "FORTIFY_APP_NAME": "<your-fortify_app_name>",
    "FORTIFY_RELEASE": "<your-fortify_release>",
    "FOD_URL": "https://ams.fortify.com",
    "SSC_URL": "<your-ssc_url>"
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
