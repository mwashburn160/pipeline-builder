# Django Python Pipeline

**Repository:** [django-ve/django-helloworld](https://github.com/django-ve/django-helloworld)
**Language:** Python
**Build Tool:** pip

## Overview

A CI/CD pipeline for a minimal Django (Python) hello-world app. It runs security
scanning only — static analysis (SAST) plus secret detection — as a compact
starting point. It does not build or test the application; adding those stages is
covered in Extending This Pipeline below.

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
| **SecurityScan** | `bandit`, `git-secrets` | Static analysis (SAST) and secret detection |

## Pipeline Flow

```
Source -> Synth -> SecurityScan
```

## Key Configuration

- **`bandit`** runs as a **`pre`** step for Python-specific static analysis (SAST),
  configured for Python 3.12 at `medium` severity
- **`git-secrets`** runs as a **`post`** step to detect committed secrets
- Source trigger is **`NONE`** (deploy/run the pipeline manually rather than on push)

## Extending This Pipeline

This sample intentionally ships with a single security stage — no build or test.
Common next steps:

- **Build** — add a stage that installs dependencies and packages the app (pip)
- **Tests + coverage** — add a stage with a pytest / coverage plugin
- **Code quality** — Ruff (lint/format) and mypy (type checking)
