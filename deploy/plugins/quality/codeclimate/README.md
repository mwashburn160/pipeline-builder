# codeclimate

Code Climate code quality and coverage reporting plugin for automated quality tracking and PR analysis using AWS CDK CodeBuildStep

**Version:** 1.0.0  
**Category:** quality  
**Plugin Type:** CodeBuildStep  
**Compute:** SMALL  
**Timeout:** 10 minutes  
**Failure Behavior:** warn  

## Keywords

`codeclimate`, `coverage`, `code-quality`, `reporting`

## Requirements

- Node.js
- Python
- Java
- 1 required secret(s) configured in AWS Secrets Manager (see [Secrets](#secrets) below)

## Secrets

| Name | Required | Description |
|------|----------|-------------|
| `CC_TEST_REPORTER_ID` | Yes | Code Climate test reporter ID |

### Setting Up Secrets

Secrets are injected at build time via AWS CodeBuild environment variables backed by AWS Secrets Manager.

**Step 1: Store secrets in AWS Secrets Manager**

```bash
aws secretsmanager create-secret --name "CC_TEST_REPORTER_ID" --secret-string "<your-value>"
```

**Step 2: Reference secrets in your pipeline configuration**

When configuring this plugin in your pipeline, map each secret to the corresponding AWS Secrets Manager ARN:

```json
{
  "secrets": {
    "CC_TEST_REPORTER_ID": "arn:aws:secretsmanager:<region>:<account>:secret:CC_TEST_REPORTER_ID"
  }
}
```

**Step 3: IAM permissions**

Ensure the CodeBuild service role has `secretsmanager:GetSecretValue` permission for the referenced secrets.

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `CC_COVERAGE_FILE` | _none_ | Cc Coverage File |

## Output

Primary output directory: `codeclimate-reports`

## Usage

This plugin runs as an AWS CDK `CodeBuildStep` within the Pipeline Builder platform. Add it as a step in your pipeline configuration:

```json
{
  "name": "codeclimate",
  "plugin": "codeclimate",
  "env": {
    "CC_COVERAGE_FILE": "<your-cc_coverage_file>"
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
