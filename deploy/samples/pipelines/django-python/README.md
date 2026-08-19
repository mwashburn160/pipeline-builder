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
repositories** (there is no anonymous GitHub source). If the token secret is
missing, the deploy fails at pipeline-creation time with:

> Secrets Manager can't find the specified secret. (ResourceNotFoundException)

This sample resolves the secret **per org** using [synth-time templating](../../../../docs/templates.md):
the source `token` references `secretsmanager:pipeline-builder/{{ pipeline.vars.orgId }}/github-token`,
following the house naming standard `pipeline-builder/{orgId}/{name}`.

**1. Set your org id.** Replace the placeholder in the `vars` block of
[`pipeline.json`](pipeline.json) with your organization's ID (the UUID, not the
display name):

```json
"vars": { "orgId": "1234abcd-…-your-org-id" }
```

**2. Create the token secret** at the matching path, once per account/region:

```bash
aws secretsmanager create-secret \
  --name "pipeline-builder/<orgId>/github-token" \
  --secret-string "ghp_YOUR_TOKEN_HERE" \
  --region <your-region>
```

Use a GitHub personal access token with `repo` + `admin:repo_hook` scopes (for a
public repo, `public_repo` + `admin:repo_hook` is sufficient). `<orgId>` must match
the `vars.orgId` you set in step 1 — at synth the token resolves to
`secretsmanager:pipeline-builder/<orgId>/github-token`.

> **Simpler alternative:** drop the `token` line and the `vars` block, and instead
> create a bare secret named `github-token` — CDK's default lookup. **Recommended
> alternative:** use a **CodeStar / CodeConnections** source (`"type": "codestar"`
> with a `connectionArn`) — see [docs/cdk-usage.md](../../../../docs/cdk-usage.md) —
> which avoids storing a PAT entirely.

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
