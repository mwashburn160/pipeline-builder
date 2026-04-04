# flyway

Flyway database migration plugin supporting migrate, repair, info, validate, and clean actions via AWS CDK CodeBuildStep

**Version:** 1.0.0  
**Category:** deploy  
**Plugin Type:** CodeBuildStep  
**Compute:** SMALL  
**Timeout:** 30 minutes  
**Failure Behavior:** fail  

## Keywords

`database`, `migration`, `flyway`, `schema`

## Requirements

- Java
- 2 required secret(s) configured in AWS Secrets Manager (see [Secrets](#secrets) below)

## Secrets

| Name | Required | Description |
|------|----------|-------------|
| `FLYWAY_USER` | Yes | Database username for Flyway connection |
| `FLYWAY_PASSWORD` | Yes | Database password for Flyway connection |

### Setting Up Secrets

Secrets are injected at build time via AWS CodeBuild environment variables backed by AWS Secrets Manager.

**Step 1: Store secrets in AWS Secrets Manager**

```bash
aws secretsmanager create-secret --name "FLYWAY_USER" --secret-string "<your-value>"
aws secretsmanager create-secret --name "FLYWAY_PASSWORD" --secret-string "<your-value>"
```

**Step 2: Reference secrets in your pipeline configuration**

When configuring this plugin in your pipeline, map each secret to the corresponding AWS Secrets Manager ARN:

```json
{
  "secrets": {
    "FLYWAY_USER": "arn:aws:secretsmanager:<region>:<account>:secret:FLYWAY_USER",
    "FLYWAY_PASSWORD": "arn:aws:secretsmanager:<region>:<account>:secret:FLYWAY_PASSWORD"
  }
}
```

**Step 3: IAM permissions**

Ensure the CodeBuild service role has `secretsmanager:GetSecretValue` permission for the referenced secrets.

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `FLYWAY_URL` | _none_ | Flyway Url |
| `FLYWAY_SCHEMAS` | _none_ | Flyway Schemas |
| `FLYWAY_LOCATIONS` | `filesystem:./sql` | Flyway Locations |
| `FLYWAY_ACTION` | `migrate` | Flyway Action |
| `FLYWAY_BASELINE_ON_MIGRATE` | `false` | Flyway Baseline On Migrate |
| `FLYWAY_OUT_OF_ORDER` | `false` | Flyway Out Of Order |

## Output

Primary output directory: `flyway-output`

## Usage

This plugin runs as an AWS CDK `CodeBuildStep` within the Pipeline Builder platform. Add it as a step in your pipeline configuration:

```json
{
  "name": "flyway",
  "plugin": "flyway",
  "env": {
    "FLYWAY_URL": "<your-flyway_url>",
    "FLYWAY_SCHEMAS": "<your-flyway_schemas>",
    "FLYWAY_LOCATIONS": "filesystem:./sql",
    "FLYWAY_ACTION": "migrate",
    "FLYWAY_BASELINE_ON_MIGRATE": "false",
    "FLYWAY_OUT_OF_ORDER": "false"
  }
}
```

## Files

| File | Description |
|------|-------------|
| `plugin-spec.yaml` | Plugin configuration and build commands |
| `Dockerfile` | Container image definition |
| `plugin.zip` | Packaged plugin archive |
| `README.md` | This documentation file |
