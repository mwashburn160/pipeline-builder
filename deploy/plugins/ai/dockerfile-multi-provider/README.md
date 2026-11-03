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
| `AI_MODEL` | _provider default_ | Model id; empty picks `claude-sonnet-5-5` (anthropic), `gpt-5.6-sol` (openai), `gemini-3.7-flash` (google), `grok-4.6` (xai), `anthropic.claude-sonnet-5-5` (bedrock) |
| `DOCKERFILE_LINT_MODE` | `enforce` | `enforce`: lint failures trigger one regeneration, then fail the step. `report`: findings are printed and written, the step passes. `off`: no lint |
| `HADOLINT_FAILURE_THRESHOLD` | `error` | hadolint severity that counts as a failure (`error`, `warning`, `info`, `style`) |
| `AI_MAX_TOKENS` | `16000` | Output-token cap (current models' thinking counts against it) |
| `AI_TIMEOUT_SECONDS` | `300` | Per-request timeout |
| `AI_MAX_RETRIES` | `4` | Retries on 429 / 529 / 5xx / transport errors, with backoff (honours `Retry-After`) |
| `AI_MAX_FILE_BYTES` | `32768` | Per-file cap on what is sent |
| `AI_MAX_CONTEXT_BYTES` | `131072` | Cap on the whole prompt context |

### Build arguments

| Argument | Default | Description |
|----------|---------|-------------|
| `HADOLINT_VERSION` | `2.15.1` | Hadolint release baked into the image (digest-verified) |

## What is sent to the provider

Only build and dependency manifests (the list in [docs/plugins/ai.md](../../../../docs/plugins/ai.md)) and the names of top-level entries, after:

- `.env*`, `*.pem`, `*.key`, keystores, SSH keys and anything named like credentials or secrets are skipped — not read, not listed;
- `environment:`, `env_file:` and build `args:` values in a compose file are replaced with `[REMOVED]` (keys kept);
- each file is capped at `AI_MAX_FILE_BYTES`;
- secret-shaped values (cloud and vendor keys, tokens, JWTs, private keys, URL credentials, `password=`/`token:` assignments) become `[REDACTED]`, ARN account fields are emptied and bare 12-digit AWS account ids masked.

## Generated Dockerfile rules

The output is a Dockerfile for **your application**, not a Pipeline Builder plugin image, so the platform's plugin rules (`plugin-base`, `fetch-verified`, uid 1000) do not apply. It is asked for, and checked against:

- official base images pinned to a version tag matching the project's declared runtime (never `:latest` or untagged; the model is told not to invent digests);
- a multi-stage build with a minimal runtime stage;
- an explicit numeric non-root `USER` in the final stage;
- no pipe-to-shell installers and no `ADD <url>`;
- no secrets in `ENV`/`ARG`/layers.

hadolint (respecting a `.hadolint.yaml` in your repo) plus a policy check for the pinned-base / non-root / pipe-to-shell rules run on the result; findings are written to `generated/dockerfile-lint.txt`.

## Output

Primary output directory: `generated`

- `generated/Dockerfile` — the generated Dockerfile
- `generated/dockerfile-lint.txt` — hadolint + policy findings (absent when lint is `off`)

## Usage

This plugin runs as an AWS CDK `CodeBuildStep` within the Pipeline Builder platform. Add it as a step in your pipeline configuration:

```json
{
  "name": "dockerfile-multi-provider",
  "plugin": "dockerfile-multi-provider",
  "env": {
    "AI_PROVIDER": "anthropic",
    "AI_MODEL": "claude-sonnet-5-5"
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
