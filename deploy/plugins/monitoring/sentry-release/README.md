# sentry-release

Sentry release tracking plugin for creating releases, associating commits, finalizing releases, and optionally uploading source maps using AWS CDK CodeBuildStep

**Version:** 1.0.0  
**Category:** monitoring  
**Plugin Type:** CodeBuildStep  
**Compute:** SMALL  
**Timeout:** 10 minutes  
**Failure Behavior:** warn  

## Keywords

`sentry`, `release`, `error-tracking`, `sourcemap`

## Requirements

- 1 required secret(s) configured in AWS Secrets Manager (see [Secrets](#secrets) below)

## Secrets

| Name | Required | Description |
|------|----------|-------------|
| `SENTRY_AUTH_TOKEN` | Yes | Sentry authentication token |

### Setting Up Secrets

Secrets are injected at build time via AWS CodeBuild environment variables backed by AWS Secrets Manager.

**Step 1: Store secrets in AWS Secrets Manager**

```bash
aws secretsmanager create-secret --name "SENTRY_AUTH_TOKEN" --secret-string "<your-value>"
```

**Step 2: Reference secrets in your pipeline configuration**

When configuring this plugin in your pipeline, map each secret to the corresponding AWS Secrets Manager ARN:

```json
{
  "secrets": {
    "SENTRY_AUTH_TOKEN": "arn:aws:secretsmanager:<region>:<account>:secret:SENTRY_AUTH_TOKEN"
  }
}
```

**Step 3: IAM permissions**

Ensure the CodeBuild service role has `secretsmanager:GetSecretValue` permission for the referenced secrets.

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `SENTRY_ORG` | _none_ | Sentry organization slug |
| `SENTRY_PROJECT` | _none_ | Sentry project slug |
| `SENTRY_RELEASE` | _none_ | Release version string (auto-detected if not set) |
| `SENTRY_SOURCEMAPS_PATH` | _none_ | Path to source maps directory for upload |

## Output

Primary output directory: `sentry-output`

## Usage

This plugin runs as an AWS CDK `CodeBuildStep` within the Pipeline Builder platform. Add it as a step in your pipeline configuration:

```json
{
  "name": "sentry-release",
  "plugin": "sentry-release",
  "env": {
    "SENTRY_ORG": "<your-sentry_org>",
    "SENTRY_PROJECT": "<your-sentry_project>",
    "SENTRY_RELEASE": "<your-sentry_release>",
    "SENTRY_SOURCEMAPS_PATH": "<your-sentry_sourcemaps_path>"
  }
}
```

## Files

| File | Description |
|------|-------------|
| `spec.yaml` | Plugin configuration and build commands |
| `Dockerfile` | Container image definition |
| `plugin.zip` | Packaged plugin archive |
| `README.md` | This documentation file |
