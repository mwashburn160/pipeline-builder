# codacy

Codacy code quality and coverage reporting plugin for automated code review and coverage tracking using AWS CDK CodeBuildStep

**Version:** 1.0.0  
**Category:** quality  
**Plugin Type:** CodeBuildStep  
**Compute:** SMALL  
**Timeout:** 10 minutes  
**Failure Behavior:** warn  

## Keywords

`codacy`, `coverage`, `code-quality`, `reporting`

## Requirements

- Node.js
- Python
- Java
- 1 required secret(s) configured in AWS Secrets Manager (see [Secrets](#secrets) below)

## Secrets

| Name | Required | Description |
|------|----------|-------------|
| `CODACY_PROJECT_TOKEN` | Yes | Codacy project API token |

### Setting Up Secrets

Secrets are injected at build time via AWS CodeBuild environment variables backed by AWS Secrets Manager.

**Step 1: Store secrets in AWS Secrets Manager**

```bash
aws secretsmanager create-secret --name "CODACY_PROJECT_TOKEN" --secret-string "<your-value>"
```

**Step 2: Reference secrets in your pipeline configuration**

When configuring this plugin in your pipeline, map each secret to the corresponding AWS Secrets Manager ARN:

```json
{
  "secrets": {
    "CODACY_PROJECT_TOKEN": "arn:aws:secretsmanager:<region>:<account>:secret:CODACY_PROJECT_TOKEN"
  }
}
```

**Step 3: IAM permissions**

Ensure the CodeBuild service role has `secretsmanager:GetSecretValue` permission for the referenced secrets.

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `CODACY_LANGUAGE` | _none_ | Codacy Language |

## Output

Primary output directory: `codacy-reports`

## Usage

This plugin runs as an AWS CDK `CodeBuildStep` within the Pipeline Builder platform. Add it as a step in your pipeline configuration:

```json
{
  "name": "codacy",
  "plugin": "codacy",
  "env": {
    "CODACY_LANGUAGE": "<your-codacy_language>"
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
