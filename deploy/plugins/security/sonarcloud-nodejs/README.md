# sonarcloud-nodejs

SonarCloud code quality and security analysis plugin for Node.js continuous inspection using AWS CDK with CodeBuildStep

**Version:** 1.0.0  
**Category:** security  
**Plugin Type:** CodeBuildStep  
**Compute:** MEDIUM  
**Timeout:** 30 minutes  
**Failure Behavior:** fail  

## Keywords

`sonarcloud-nodejs`, `sonarcloud`, `sonar`, `security`, `code-quality`, `sast`, `static-analysis`, `nodejs`

## Requirements

- Node.js
- 1 required secret(s) configured in AWS Secrets Manager (see [Secrets](#secrets) below)

## Secrets

| Name | Required | Description |
|------|----------|-------------|
| `SONAR_TOKEN` | Yes | SonarCloud authentication token |

### Setting Up Secrets

Secrets are injected at build time via AWS CodeBuild environment variables backed by AWS Secrets Manager.

**Step 1: Store secrets in AWS Secrets Manager**

```bash
aws secretsmanager create-secret --name "SONAR_TOKEN" --secret-string "<your-value>"
```

**Step 2: Reference secrets in your pipeline configuration**

When configuring this plugin in your pipeline, map each secret to the corresponding AWS Secrets Manager ARN:

```json
{
  "secrets": {
    "SONAR_TOKEN": "arn:aws:secretsmanager:<region>:<account>:secret:SONAR_TOKEN"
  }
}
```

**Step 3: IAM permissions**

Ensure the CodeBuild service role has `secretsmanager:GetSecretValue` permission for the referenced secrets.

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `SONAR_SCANNER_VERSION` | `12.0` | Sonar Scanner Version |
| `SONAR_ORGANIZATION` | _none_ | Sonar Organization |
| `SONAR_PROJECT_KEY` | _none_ | Sonar Project Key |
| `LANGUAGE` | `nodejs` | Target language for scanning |
| `LANGUAGE_VERSION` | _none_ | Language runtime version |

## Output

Primary output directory: `.scannerwork`

## Usage

This plugin runs as an AWS CDK `CodeBuildStep` within the Pipeline Builder platform. Add it as a step in your pipeline configuration:

```json
{
  "name": "sonarcloud-nodejs",
  "plugin": "sonarcloud-nodejs",
  "env": {
    "SONAR_SCANNER_VERSION": "12.0",
    "SONAR_ORGANIZATION": "<your-sonar_organization>",
    "SONAR_PROJECT_KEY": "<your-sonar_project_key>",
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
