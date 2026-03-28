# maven-publish

Maven artifact publish plugin for deploying Java/Kotlin packages to Maven Central via OSSRH or custom repositories with GPG signing using AWS CDK CodeBuildStep

**Version:** 1.0.0  
**Category:** artifact  
**Plugin Type:** CodeBuildStep  
**Compute:** SMALL  
**Timeout:** 15 minutes  
**Failure Behavior:** fail  

## Keywords

`java`, `maven`, `maven-central`, `publish`

## Requirements

- Java
- 2 required secret(s) configured in AWS Secrets Manager (see [Secrets](#secrets) below)
- 1 optional secret(s) for additional features (see [Secrets](#secrets) below)

## Secrets

| Name | Required | Description |
|------|----------|-------------|
| `OSSRH_USERNAME` | Yes | Maven Central (OSSRH) username |
| `OSSRH_PASSWORD` | Yes | Maven Central (OSSRH) password |
| `GPG_PASSPHRASE` | No | GPG key passphrase for artifact signing |

### Setting Up Secrets

Secrets are injected at build time via AWS CodeBuild environment variables backed by AWS Secrets Manager.

**Step 1: Store secrets in AWS Secrets Manager**

```bash
aws secretsmanager create-secret --name "OSSRH_USERNAME" --secret-string "<your-value>"
aws secretsmanager create-secret --name "OSSRH_PASSWORD" --secret-string "<your-value>"
aws secretsmanager create-secret --name "GPG_PASSPHRASE" --secret-string "<your-value>"
```

**Step 2: Reference secrets in your pipeline configuration**

When configuring this plugin in your pipeline, map each secret to the corresponding AWS Secrets Manager ARN:

```json
{
  "secrets": {
    "OSSRH_USERNAME": "arn:aws:secretsmanager:<region>:<account>:secret:OSSRH_USERNAME",
    "OSSRH_PASSWORD": "arn:aws:secretsmanager:<region>:<account>:secret:OSSRH_PASSWORD",
    "GPG_PASSPHRASE": "arn:aws:secretsmanager:<region>:<account>:secret:GPG_PASSPHRASE"
  }
}
```

**Step 3: IAM permissions**

Ensure the CodeBuild service role has `secretsmanager:GetSecretValue` permission for the referenced secrets.

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `MAVEN_REPOSITORY_URL` | _none_ | Maven repository URL |

## Output

Primary output directory: `publish-output`

## Usage

This plugin runs as an AWS CDK `CodeBuildStep` within the Pipeline Builder platform. Add it as a step in your pipeline configuration:

```json
{
  "name": "maven-publish",
  "plugin": "maven-publish",
  "env": {
    "MAVEN_REPOSITORY_URL": "<your-maven_repository_url>"
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
