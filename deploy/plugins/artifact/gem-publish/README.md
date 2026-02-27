# gem-publish

RubyGems package publish plugin for deploying Ruby gems to RubyGems.org with dry-run support using AWS CDK CodeBuildStep

**Version:** 1.0.0  
**Category:** artifact  
**Plugin Type:** CodeBuildStep  
**Compute:** SMALL  
**Timeout:** 15 minutes  
**Failure Behavior:** fail  

## Keywords

`gem`, `publish`, `ruby`, `rubygems`, `package`

## Requirements

- 1 required secret(s) configured in AWS Secrets Manager (see [Secrets](#secrets) below)

## Secrets

| Name | Required | Description |
|------|----------|-------------|
| `GEM_HOST_API_KEY` | Yes | RubyGems API key |

### Setting Up Secrets

Secrets are injected at build time via AWS CodeBuild environment variables backed by AWS Secrets Manager.

**Step 1: Store secrets in AWS Secrets Manager**

```bash
aws secretsmanager create-secret --name "GEM_HOST_API_KEY" --secret-string "<your-value>"
```

**Step 2: Reference secrets in your pipeline configuration**

When configuring this plugin in your pipeline, map each secret to the corresponding AWS Secrets Manager ARN:

```json
{
  "secrets": {
    "GEM_HOST_API_KEY": "arn:aws:secretsmanager:<region>:<account>:secret:GEM_HOST_API_KEY"
  }
}
```

**Step 3: IAM permissions**

Ensure the CodeBuild service role has `secretsmanager:GetSecretValue` permission for the referenced secrets.

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `GEM_DRY_RUN` | `false` | Gem Dry Run |

## Output

Primary output directory: `publish-output`

## Usage

This plugin runs as an AWS CDK `CodeBuildStep` within the Pipeline Builder platform. Add it as a step in your pipeline configuration:

```json
{
  "name": "gem-publish",
  "plugin": "gem-publish",
  "env": {
    "GEM_DRY_RUN": "false"
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
