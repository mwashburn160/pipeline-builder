# dockerfile-multi-provider

AI-powered Dockerfile generator that analyzes project source code and produces an optimized, production-ready Dockerfile using cloud AI providers (Anthropic, OpenAI, Google, xAI)

**Version:** 1.0.0  
**Category:** ai  
**Plugin Type:** CodeBuildStep  
**Compute:** MEDIUM  
**Timeout:** 15 minutes  
**Failure Behavior:** fail  

## Keywords

`dockerfile`, `ai`, `anthropic`, `openai`, `code-generation`

## Requirements

- An API key for the chosen AI provider (except when using the `bedrock` provider with IAM credentials)
- AWS CLI configured with appropriate permissions (required only for the `bedrock` provider)

## Secrets

| Name | Required | Description |
|------|----------|-------------|
| `AI_API_KEY` | No | Required for all providers except bedrock |

### Setting Up Secrets

Secrets are injected at build time via AWS CodeBuild environment variables backed by AWS Secrets Manager.

**Step 1: Store secrets in AWS Secrets Manager**

```bash
aws secretsmanager create-secret --name "AI_API_KEY" --secret-string "<your-value>"
```

**Step 2: Reference secrets in your pipeline configuration**

When configuring this plugin in your pipeline, map each secret to the corresponding AWS Secrets Manager ARN:

```json
{
  "secrets": {
    "AI_API_KEY": "arn:aws:secretsmanager:<region>:<account>:secret:AI_API_KEY"
  }
}
```

**Step 3: IAM permissions**

Ensure the CodeBuild service role has `secretsmanager:GetSecretValue` permission for the referenced secrets.

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `AI_PROVIDER` | `anthropic` | AI provider (anthropic, openai, google, xai, bedrock) |
| `AI_MODEL` | `claude-sonnet-4-20250514` | AI model identifier for the chosen provider |

## Output

Primary output directory: `generated`

## Usage

This plugin runs as an AWS CDK `CodeBuildStep` within the Pipeline Builder platform. Add it as a step in your pipeline configuration:

```json
{
  "name": "dockerfile-multi-provider",
  "plugin": "dockerfile-multi-provider",
  "env": {
    "AI_PROVIDER": "anthropic",
    "AI_MODEL": "claude-sonnet-4-20250514"
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
