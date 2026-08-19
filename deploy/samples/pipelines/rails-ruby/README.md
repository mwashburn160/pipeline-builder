# Rails Ruby Pipeline

**Repository:** [m9rc1n/hello-world-rails](https://github.com/m9rc1n/hello-world-rails)
**Language:** Ruby
**Build Tool:** Bundler

## Overview

A minimal CI/CD pipeline for a Rails (Ruby) hello-world app. It runs security
scanning only — Rails SAST via Brakeman, dependency auditing via bundler-audit,
and secret detection via git-secrets. It does not build or test the application.

## Prerequisites

This pipeline uses a **GitHub (v1/OAuth) source**. AWS CodePipeline authenticates
that source with an OAuth token stored in AWS Secrets Manager — **even for public
repositories** (there is no anonymous GitHub source). When the source options omit
an explicit `token`, CDK looks up a secret named **`github-token`** by default.

If that secret does not exist, the deploy fails at pipeline-creation time with:

> Secrets Manager can't find the specified secret. (ResourceNotFoundException)

Create it once per account/region before deploying:

```bash
aws secretsmanager create-secret \
  --name github-token \
  --secret-string "ghp_YOUR_TOKEN_HERE" \
  --region <your-region>
```

Use a GitHub personal access token with `repo` + `admin:repo_hook` scopes (for a
public repo, `public_repo` + `admin:repo_hook` is sufficient).

> **Alternative (recommended):** use a **CodeStar / CodeConnections** source
> (`"type": "codestar"` with a `connectionArn`) instead of a PAT — see
> [docs/cdk-usage.md](../../../../docs/cdk-usage.md). It avoids storing a token and
> is AWS's modern GitHub integration.

## Stages

| Stage | Plugins | Purpose |
|-------|---------|---------|
| **SecurityScan** | `brakeman`, `bundler-audit`, `git-secrets` | Security scanning (Rails SAST, dependency audit, secret detection) |

## Pipeline Flow

```
Source -> Synth -> SecurityScan
```

## Key Configuration

- **Brakeman** (Rails SAST) runs as a **`pre`** step
- **bundler-audit** (gem dependency audit) runs as a **`pre`** step
- **git-secrets** (secret detection) runs as a **`post`** step
- Source trigger is **`NONE`** (deploy/run the pipeline manually rather than on push)

## Extending This Pipeline

This sample intentionally ships with a single security-scan stage. Common next steps:

- **Build** — add a stage that installs gems and prepares the app (Bundler)
- **Tests** — add a `rails-test` stage to run the test suite
- **Linting** — add a `rubocop` stage for code style enforcement and static analysis
