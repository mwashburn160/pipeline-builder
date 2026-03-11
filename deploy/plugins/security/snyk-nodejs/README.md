# snyk-nodejs

Snyk security scanning plugin for Node.js vulnerability detection in dependencies and code using AWS CDK with CodeBuildStep

**Version:** 1.0.0  
**Category:** security  
**Plugin Type:** CodeBuildStep  
**Compute:** MEDIUM  
**Timeout:** 30 minutes  
**Failure Behavior:** fail  

## Keywords

`snyk-nodejs`, `snyk`, `security`, `vulnerability`, `sca`, `sast`, `nodejs`

## Requirements

- Node.js
- 1 required secret(s) configured in AWS Secrets Manager (see [Secrets](#secrets) below)

## Secrets

| Name | Required | Description |
|------|----------|-------------|
| `SNYK_TOKEN` | Yes | Snyk authentication token |

### Setting Up Secrets

Secrets are injected at build time via AWS CodeBuild environment variables backed by AWS Secrets Manager.

**Step 1: Store secrets in AWS Secrets Manager**

```bash
aws secretsmanager create-secret --name "SNYK_TOKEN" --secret-string "<your-value>"
```

**Step 2: Reference secrets in your pipeline configuration**

When configuring this plugin in your pipeline, map each secret to the corresponding AWS Secrets Manager ARN:

```json
{
  "secrets": {
    "SNYK_TOKEN": "arn:aws:secretsmanager:<region>:<account>:secret:SNYK_TOKEN"
  }
}
```

**Step 3: IAM permissions**

Ensure the CodeBuild service role has `secretsmanager:GetSecretValue` permission for the referenced secrets.

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `SNYK_VERSION` | `latest` | Snyk CLI version |
| `SNYK_SEVERITY_THRESHOLD` | `high` | Minimum severity level to report (low, medium, high, critical) |
| `LANGUAGE` | `nodejs` | Target language for scanning |
| `LANGUAGE_VERSION` | _none_ | Language runtime version |

## Output

Primary output directory: `snyk-reports`

## Usage

This plugin runs as an AWS CDK `CodeBuildStep` within the Pipeline Builder platform. Add it as a step in your pipeline configuration:

```json
{
  "name": "snyk-nodejs",
  "plugin": "snyk-nodejs",
  "env": {
    "SNYK_VERSION": "latest",
    "SNYK_SEVERITY_THRESHOLD": "high",
    "LANGUAGE": "nodejs",
    "LANGUAGE_VERSION": "<your-language_version>"
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
