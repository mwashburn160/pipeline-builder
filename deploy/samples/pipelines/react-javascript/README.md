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
