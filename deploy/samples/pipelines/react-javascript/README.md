# React JavaScript Pipeline

**Repository:** [sitek94/vite-deploy-demo](https://github.com/sitek94/vite-deploy-demo)
**Language:** JavaScript / TypeScript
**Build Tool:** Vite / npm

## Overview

A CI/CD pipeline for a minimal React (Vite, JavaScript) hello-world app. It builds
the application with npm and runs a security scan — a compact starting point you can
extend with test, coverage, quality, and container-packaging stages.

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
| **BuildAndPackage** | `nodejs-bundle` | Build the application with npm on Node.js |
| **SecurityScan** | `npm-audit`, `git-secrets` | Dependency audit and secret scanning |

## Pipeline Flow

```
Source -> Synth -> BuildAndPackage -> SecurityScan
```

## Key Configuration

- **npm build** via the `nodejs-bundle` plugin (`NODE_VERSION` 24, `BUILD_SCRIPT` `build`)
  as a **`pre`** step with a **20-minute** timeout
- **`npm-audit`** runs as a **`pre`** step at `AUDIT_LEVEL` **high** with **`warn`**
  failure behavior (advisory-only vulnerabilities do not block the pipeline)
- **`git-secrets`** runs as a **`post`** step, also with **`warn`** failure behavior
- Source trigger is **`NONE`** (deploy/run the pipeline manually rather than on push)

## Extending This Pipeline

This sample intentionally ships with just a build and a security stage. Common next steps:

- **Tests + coverage** — add a stage with a Jest (or Vitest) plugin and coverage thresholds
- **Code quality** — ESLint / Prettier for style enforcement and static analysis
- **Container image** — a `docker-build` stage that packages the built bundle behind a
  web server (e.g. nginx)
