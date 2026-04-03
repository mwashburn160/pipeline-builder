# pulumi

Pulumi infrastructure-as-code deployment plugin supporting TypeScript, Python, Go, and YAML with preview, up, and destroy actions using AWS CDK CodeBuildStep

**Version:** 1.0.0
**Category:** deploy
**Plugin Type:** CodeBuildStep
**Compute:** MEDIUM
**Timeout:** 45 minutes
**Failure Behavior:** fail

## Keywords

`infrastructure-as-code`, `pulumi`, `multi-cloud`, `deploy`

## Requirements

- AWS CLI configured with appropriate permissions
- Node.js 24 (for TypeScript/JavaScript runtime)
- Python 3 (for Python runtime)
- Go 1.24 (for Go runtime)
- 1 required secret configured in AWS Secrets Manager (see [Secrets](#secrets) below)

## Secrets

| Name | Required | Description |
|------|----------|-------------|
| `PULUMI_ACCESS_TOKEN` | Yes | Pulumi access token for state management |

### Setting Up Secrets

Secrets are injected at build time via AWS CodeBuild environment variables backed by AWS Secrets Manager.

**Step 1: Store secrets in AWS Secrets Manager**

```bash
aws secretsmanager create-secret --name "PULUMI_ACCESS_TOKEN" --secret-string "<your-value>"
```

**Step 2: Reference secrets in your pipeline configuration**

When configuring this plugin in your pipeline, map each secret to the corresponding AWS Secrets Manager ARN:

```json
{
  "secrets": {
    "PULUMI_ACCESS_TOKEN": "arn:aws:secretsmanager:<region>:<account>:secret:PULUMI_ACCESS_TOKEN"
  }
}
```

**Step 3: IAM permissions**

Ensure the CodeBuild service role has `secretsmanager:GetSecretValue` permission for the referenced secrets.

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `PULUMI_ACTION` | `preview` | Pulumi action: preview, up, or destroy |
| `PULUMI_STACK` | _none_ | Pulumi stack to select |
| `PULUMI_RUNTIME` | `nodejs` | Pulumi runtime: nodejs, python, go, or yaml |
| `PULUMI_WORK_DIR` | `.` | Directory containing the Pulumi program |

## Output

Primary output directory: `pulumi-output`

## Usage

This plugin runs as an AWS CDK `CodeBuildStep` within the Pipeline Builder platform. Add it as a step in your pipeline configuration:

```json
{
  "name": "pulumi",
  "plugin": "pulumi",
  "env": {
    "PULUMI_ACTION": "preview",
    "PULUMI_STACK": "<your-stack-name>",
    "PULUMI_RUNTIME": "nodejs",
    "PULUMI_WORK_DIR": "."
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
