# liquibase

Liquibase database migration plugin supporting update, rollback, status, validate, and diff actions via AWS CDK CodeBuildStep

**Version:** 1.0.0  
**Category:** deploy  
**Plugin Type:** CodeBuildStep  
**Compute:** SMALL  
**Timeout:** 30 minutes  
**Failure Behavior:** fail  

## Keywords

`liquibase`, `database`, `migration`, `changelog`, `schema`, `deploy`

## Requirements

- Java
- 2 required secret(s) configured in AWS Secrets Manager (see [Secrets](#secrets) below)

## Secrets

| Name | Required | Description |
|------|----------|-------------|
| `LIQUIBASE_USERNAME` | Yes | Database username for Liquibase connection |
| `LIQUIBASE_PASSWORD` | Yes | Database password for Liquibase connection |

### Setting Up Secrets

Secrets are injected at build time via AWS CodeBuild environment variables backed by AWS Secrets Manager.

**Step 1: Store secrets in AWS Secrets Manager**

```bash
aws secretsmanager create-secret --name "LIQUIBASE_USERNAME" --secret-string "<your-value>"
aws secretsmanager create-secret --name "LIQUIBASE_PASSWORD" --secret-string "<your-value>"
```

**Step 2: Reference secrets in your pipeline configuration**

When configuring this plugin in your pipeline, map each secret to the corresponding AWS Secrets Manager ARN:

```json
{
  "secrets": {
    "LIQUIBASE_USERNAME": "arn:aws:secretsmanager:<region>:<account>:secret:LIQUIBASE_USERNAME",
    "LIQUIBASE_PASSWORD": "arn:aws:secretsmanager:<region>:<account>:secret:LIQUIBASE_PASSWORD"
  }
}
```

**Step 3: IAM permissions**

Ensure the CodeBuild service role has `secretsmanager:GetSecretValue` permission for the referenced secrets.

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `LIQUIBASE_URL` | _none_ | Liquibase Url |
| `LIQUIBASE_CHANGELOG_FILE` | `changelog.xml` | Liquibase Changelog File |
| `LIQUIBASE_ACTION` | `update` | Liquibase Action |
| `LIQUIBASE_CONTEXTS` | _none_ | Liquibase Contexts |
| `LIQUIBASE_LABELS` | _none_ | Liquibase Labels |
| `ROLLBACK_COUNT` | `1` | Rollback Count |

## Output

Primary output directory: `liquibase-output`

## Usage

This plugin runs as an AWS CDK `CodeBuildStep` within the Pipeline Builder platform. Add it as a step in your pipeline configuration:

```json
{
  "name": "liquibase",
  "plugin": "liquibase",
  "env": {
    "LIQUIBASE_URL": "<your-liquibase_url>",
    "LIQUIBASE_CHANGELOG_FILE": "changelog.xml",
    "LIQUIBASE_ACTION": "update",
    "LIQUIBASE_CONTEXTS": "<your-liquibase_contexts>",
    "LIQUIBASE_LABELS": "<your-liquibase_labels>",
    "ROLLBACK_COUNT": "1"
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
