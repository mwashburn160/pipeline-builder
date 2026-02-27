# npm-publish

NPM package publish plugin for deploying Node.js packages to the npm registry with tag and access control support using AWS CDK CodeBuildStep

**Version:** 1.0.0  
**Category:** artifact  
**Plugin Type:** CodeBuildStep  
**Compute:** SMALL  
**Timeout:** 15 minutes  
**Failure Behavior:** fail  

## Keywords

`npm`, `publish`, `registry`, `nodejs`, `package`

## Requirements

- Node.js
- 1 required secret(s) configured in AWS Secrets Manager (see [Secrets](#secrets) below)

## Secrets

| Name | Required | Description |
|------|----------|-------------|
| `NPM_TOKEN` | Yes | npm registry authentication token |

### Setting Up Secrets

Secrets are injected at build time via AWS CodeBuild environment variables backed by AWS Secrets Manager.

**Step 1: Store secrets in AWS Secrets Manager**

```bash
aws secretsmanager create-secret --name "NPM_TOKEN" --secret-string "<your-value>"
```

**Step 2: Reference secrets in your pipeline configuration**

When configuring this plugin in your pipeline, map each secret to the corresponding AWS Secrets Manager ARN:

```json
{
  "secrets": {
    "NPM_TOKEN": "arn:aws:secretsmanager:<region>:<account>:secret:NPM_TOKEN"
  }
}
```

**Step 3: IAM permissions**

Ensure the CodeBuild service role has `secretsmanager:GetSecretValue` permission for the referenced secrets.

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `NPM_DRY_RUN` | `false` | Npm Dry Run |
| `NPM_TAG` | `latest` | Npm Tag |
| `NPM_ACCESS` | `public` | Npm Access |

## Output

Primary output directory: `publish-output`

## Usage

This plugin runs as an AWS CDK `CodeBuildStep` within the Pipeline Builder platform. Add it as a step in your pipeline configuration:

```json
{
  "name": "npm-publish",
  "plugin": "npm-publish",
  "env": {
    "NPM_DRY_RUN": "false",
    "NPM_TAG": "latest",
    "NPM_ACCESS": "public"
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
