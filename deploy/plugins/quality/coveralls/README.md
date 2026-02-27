# coveralls

Coveralls coverage reporting plugin for uploading and tracking code coverage with badge support and PR status checks using AWS CDK CodeBuildStep

**Version:** 1.0.0  
**Category:** quality  
**Plugin Type:** CodeBuildStep  
**Compute:** SMALL  
**Timeout:** 10 minutes  
**Failure Behavior:** warn  

## Keywords

`coveralls`, `coverage`, `reporting`, `badge`

## Requirements

- Node.js
- Python
- Java
- 1 required secret(s) configured in AWS Secrets Manager (see [Secrets](#secrets) below)

## Secrets

| Name | Required | Description |
|------|----------|-------------|
| `COVERALLS_REPO_TOKEN` | Yes | Coveralls repository token |

### Setting Up Secrets

Secrets are injected at build time via AWS CodeBuild environment variables backed by AWS Secrets Manager.

**Step 1: Store secrets in AWS Secrets Manager**

```bash
aws secretsmanager create-secret --name "COVERALLS_REPO_TOKEN" --secret-string "<your-value>"
```

**Step 2: Reference secrets in your pipeline configuration**

When configuring this plugin in your pipeline, map each secret to the corresponding AWS Secrets Manager ARN:

```json
{
  "secrets": {
    "COVERALLS_REPO_TOKEN": "arn:aws:secretsmanager:<region>:<account>:secret:COVERALLS_REPO_TOKEN"
  }
}
```

**Step 3: IAM permissions**

Ensure the CodeBuild service role has `secretsmanager:GetSecretValue` permission for the referenced secrets.

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `COVERALLS_SERVICE_NAME` | `codebuild` | Coveralls Service Name |

## Output

Primary output directory: `coveralls-reports`

## Usage

This plugin runs as an AWS CDK `CodeBuildStep` within the Pipeline Builder platform. Add it as a step in your pipeline configuration:

```json
{
  "name": "coveralls",
  "plugin": "coveralls",
  "env": {
    "COVERALLS_SERVICE_NAME": "codebuild"
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
