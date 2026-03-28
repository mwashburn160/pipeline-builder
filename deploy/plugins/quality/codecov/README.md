# codecov

Codecov coverage reporting plugin for uploading and tracking code coverage with PR comments and badges using AWS CDK CodeBuildStep

**Version:** 1.0.0  
**Category:** quality  
**Plugin Type:** CodeBuildStep  
**Compute:** SMALL  
**Timeout:** 10 minutes  
**Failure Behavior:** warn  

## Keywords

`coverage`, `reporting`, `badge`, `threshold`

## Requirements

- Node.js 24
- 1 required secret(s) configured in AWS Secrets Manager (see [Secrets](#secrets) below)

## Secrets

| Name | Required | Description |
|------|----------|-------------|
| `CODECOV_TOKEN` | Yes | Codecov upload token |

### Setting Up Secrets

Secrets are injected at build time via AWS CodeBuild environment variables backed by AWS Secrets Manager.

**Step 1: Store secrets in AWS Secrets Manager**

```bash
aws secretsmanager create-secret --name "CODECOV_TOKEN" --secret-string "<your-value>"
```

**Step 2: Reference secrets in your pipeline configuration**

When configuring this plugin in your pipeline, map each secret to the corresponding AWS Secrets Manager ARN:

```json
{
  "secrets": {
    "CODECOV_TOKEN": "arn:aws:secretsmanager:<region>:<account>:secret:CODECOV_TOKEN"
  }
}
```

**Step 3: IAM permissions**

Ensure the CodeBuild service role has `secretsmanager:GetSecretValue` permission for the referenced secrets.

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `CODECOV_FLAGS` | _none_ | Codecov Flags |
| `CODECOV_FILE` | _none_ | Codecov File |

## Output

Primary output directory: `codecov-reports`

## Usage

This plugin runs as an AWS CDK `CodeBuildStep` within the Pipeline Builder platform. Add it as a step in your pipeline configuration:

```json
{
  "name": "codecov",
  "plugin": "codecov",
  "env": {
    "CODECOV_FLAGS": "<your-codecov_flags>",
    "CODECOV_FILE": "<your-codecov_file>"
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
