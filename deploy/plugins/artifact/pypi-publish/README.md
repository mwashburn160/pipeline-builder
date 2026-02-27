# pypi-publish

PyPI package publish plugin for deploying Python packages to PyPI or custom repositories using twine with AWS CDK CodeBuildStep

**Version:** 1.0.0  
**Category:** artifact  
**Plugin Type:** CodeBuildStep  
**Compute:** SMALL  
**Timeout:** 15 minutes  
**Failure Behavior:** fail  

## Keywords

`pypi`, `publish`, `python`, `package`, `twine`

## Requirements

- Python
- 2 required secret(s) configured in AWS Secrets Manager (see [Secrets](#secrets) below)

## Secrets

| Name | Required | Description |
|------|----------|-------------|
| `TWINE_USERNAME` | Yes | PyPI upload username |
| `TWINE_PASSWORD` | Yes | PyPI upload password |

### Setting Up Secrets

Secrets are injected at build time via AWS CodeBuild environment variables backed by AWS Secrets Manager.

**Step 1: Store secrets in AWS Secrets Manager**

```bash
aws secretsmanager create-secret --name "TWINE_USERNAME" --secret-string "<your-value>"
aws secretsmanager create-secret --name "TWINE_PASSWORD" --secret-string "<your-value>"
```

**Step 2: Reference secrets in your pipeline configuration**

When configuring this plugin in your pipeline, map each secret to the corresponding AWS Secrets Manager ARN:

```json
{
  "secrets": {
    "TWINE_USERNAME": "arn:aws:secretsmanager:<region>:<account>:secret:TWINE_USERNAME",
    "TWINE_PASSWORD": "arn:aws:secretsmanager:<region>:<account>:secret:TWINE_PASSWORD"
  }
}
```

**Step 3: IAM permissions**

Ensure the CodeBuild service role has `secretsmanager:GetSecretValue` permission for the referenced secrets.

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `PYPI_REPOSITORY` | _none_ | Pypi Repository |
| `TWINE_USERNAME` | `__token__` | Twine Username |

## Output

Primary output directory: `publish-output`

## Usage

This plugin runs as an AWS CDK `CodeBuildStep` within the Pipeline Builder platform. Add it as a step in your pipeline configuration:

```json
{
  "name": "pypi-publish",
  "plugin": "pypi-publish",
  "env": {
    "PYPI_REPOSITORY": "<your-pypi_repository>",
    "TWINE_USERNAME": "__token__"
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
