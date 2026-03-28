# github-status

GitHub commit status and check run plugin for posting build results back to pull requests and commits using AWS CDK CodeBuildStep

**Version:** 1.0.0
**Category:** notification
**Plugin Type:** CodeBuildStep
**Compute:** SMALL
**Timeout:** 5 minutes
**Failure Behavior:** warn

## Keywords

`github`, `commit-status`, `check-run`, `notification`

## Requirements

- GitHub CLI and curl (included in container image)
- 1 required secret configured in AWS Secrets Manager (see [Secrets](#secrets) below)

## Secrets

| Name | Required | Description |
|------|----------|-------------|
| `GITHUB_TOKEN` | Yes | GitHub personal access token or app token |

### Setting Up Secrets

Secrets are injected at build time via AWS CodeBuild environment variables backed by AWS Secrets Manager.

**Step 1: Store secrets in AWS Secrets Manager**

```bash
aws secretsmanager create-secret --name "GITHUB_TOKEN" --secret-string "<your-value>"
```

**Step 2: Reference secrets in your pipeline configuration**

When configuring this plugin in your pipeline, map each secret to the corresponding AWS Secrets Manager ARN:

```json
{
  "secrets": {
    "GITHUB_TOKEN": "arn:aws:secretsmanager:<region>:<account>:secret:GITHUB_TOKEN"
  }
}
```

**Step 3: IAM permissions**

Ensure the CodeBuild service role has `secretsmanager:GetSecretValue` permission for the referenced secrets.

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `GITHUB_OWNER` | _none_ | GitHub repository owner (user or organization) |
| `GITHUB_REPO` | _none_ | GitHub repository name |
| `GITHUB_SHA` | _none_ | Git commit SHA to post status against |
| `STATUS_STATE` | `success` | Commit status state: `success`, `failure`, `error`, or `pending` |
| `STATUS_CONTEXT` | `pipeline` | Status context label shown on the commit/PR |
| `STATUS_DESCRIPTION` | _none_ | Short description for the status check |
| `STATUS_TARGET_URL` | _none_ | URL to link from the status check (e.g., build logs) |

## Output

Primary output directory: `notify-output`

## Usage

This plugin runs as an AWS CDK `CodeBuildStep` within the Pipeline Builder platform. Add it as a step in your pipeline configuration:

```json
{
  "name": "github-status",
  "plugin": "github-status",
  "env": {
    "GITHUB_OWNER": "<your-github-owner>",
    "GITHUB_REPO": "<your-github-repo>",
    "GITHUB_SHA": "<commit-sha>",
    "STATUS_STATE": "success",
    "STATUS_CONTEXT": "pipeline",
    "STATUS_DESCRIPTION": "Build passed"
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
