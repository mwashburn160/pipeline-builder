---
layout: default
title: Samples
---

# Samples

Ready-to-use pipeline configurations and CDK examples that demonstrate Pipeline Builder's capabilities. Use these as starting points for your own pipelines or as reference implementations for advanced patterns.

All sample files are located in [`deploy/samples/`](../deploy/samples/).

**Related docs:** [Plugin Catalog](plugins/README.md) | [Metadata Keys](metadata-keys.md) | [API Reference](api-reference.md)

---

## Overview

This catalog indexes the ready-to-use pipeline configs and CDK examples shipped in [`deploy/samples/`](../deploy/samples/). It covers seven language-specific CI/CD pipelines (React, Spring Boot, Django, Gin, Axum, Rails, ASP.NET Core) and six `PipelineBuilder` CDK stack examples — VPC isolation, multi-account, monorepo, custom IAM roles, and secrets management — plus how to bulk-load them into a running instance. Use them as starting points for your own pipelines or as reference implementations for advanced patterns.

---

## Pipeline Samples

Language-specific CI/CD pipelines built on small, real hello-world repos. Each sample is an intentionally minimal starting point — a build and/or security-scan stage — that you extend with tests, linting, and container packaging (see each sample's README).

**Location:** [`deploy/samples/pipelines/`](../deploy/samples/pipelines/)

| Sample | Language | Source Repo | Stages |
|--------|----------|-------------|--------|
| [react-javascript](../deploy/samples/pipelines/react-javascript/) | JS/TS | sitek94/vite-deploy-demo | Build, Security |
| [spring-boot-java](../deploy/samples/pipelines/spring-boot-java/) | Java | dstar55/docker-hello-world-spring-boot | Build |
| [django-python](../deploy/samples/pipelines/django-python/) | Python | django-ve/django-helloworld | Security |
| [gin-golang](../deploy/samples/pipelines/gin-golang/) | Go | lamhotsimamora/Hello-World-Golang-Gin | Build, Security |
| [axum-rust](../deploy/samples/pipelines/axum-rust/) | Rust | ChiefTechDev/Rust-Axum-Hello-World | Build, Security |
| [rails-ruby](../deploy/samples/pipelines/rails-ruby/) | Ruby | m9rc1n/hello-world-rails | Security |
| [aspnetcore-dotnet](../deploy/samples/pipelines/aspnetcore-dotnet/) | C#/.NET | Azure-Samples/dotnetcore-docs-hello-world | Build, Security |

### Prerequisite: GitHub source token

All seven pipelines use a **GitHub (v1/OAuth) source**, which CodePipeline authenticates with an OAuth token in AWS Secrets Manager — **even for public repos**. When the source options omit a `token`, CDK looks up a secret named **`github-token`** by default; if it doesn't exist, the deploy fails at pipeline-creation time with `Secrets Manager can't find the specified secret. (ResourceNotFoundException)`.

Create it once per account/region before deploying:

```bash
aws secretsmanager create-secret \
  --name github-token \
  --secret-string "ghp_YOUR_TOKEN_HERE" \
  --region <your-region>
```

Use a PAT with `repo` + `admin:repo_hook` scopes (public repos: `public_repo` + `admin:repo_hook`). To follow the org-scoped naming standard (`pipeline-builder/{orgId}/{name}`) instead, store it at `pipeline-builder/<orgId>/github-token` and set the source `token` to `secretsmanager:pipeline-builder/<orgId>/github-token`. A [CodeStar/CodeConnections](cdk-usage.md#codestar-connection-github-bitbucket-gitlab) source avoids the token entirely.

### Patterns

- **Plugin filters** — every plugin reference includes a `filter` (`version`, `accessModifier`, `isActive`, `isDefault`) so the resolved plugin version is explicit and reproducible
- **Failure behavior** — advisory checks (e.g. dependency audits) use `failureBehavior: "warn"` so they report findings without failing the build
- **Step positioning** — primary steps use `"pre"`, supplementary steps use `"post"`
- **Compute sizing** — heavier steps override the default compute to `MEDIUM` or `LARGE` via the `aws:cdk:codebuild:buildenvironment:computetype` metadata key

---

## CDK TypeScript Examples

Self-contained stack classes showing `PipelineBuilder` usage.

**Location:** [`deploy/samples/cdk/`](../deploy/samples/cdk/)

| Sample | Pattern |
|--------|---------|
| [basic-pipeline-ts](../deploy/samples/cdk/basic-pipeline-ts/) | Simplest usage — GitHub source, plugin filters, 4 stages |
| [vpc-isolated-pipeline-ts](../deploy/samples/cdk/vpc-isolated-pipeline-ts/) | VPC networking with `NetworkConfig` and step-level overrides |
| [multi-account-pipeline-ts](../deploy/samples/cdk/multi-account-pipeline-ts/) | Cross-account with `RoleConfig`, CodeStar source, ManualApproval |
| [monorepo-pipeline-ts](../deploy/samples/cdk/monorepo-pipeline-ts/) | Monorepo with factory functions, pnpm workspace, per-service Docker |
| [custom-iam-roles-ts](../deploy/samples/cdk/custom-iam-roles-ts/) | Three levels of IAM role control (pipeline, step project, step action) |
| [secrets-management-ts](../deploy/samples/cdk/secrets-management-ts/) | Secrets Manager integration with `orgId`-scoped resolution |

### IAM Role Levels

From [custom-iam-roles-ts](../deploy/samples/cdk/custom-iam-roles-ts/):

| Level | Config | Trust Principal |
|-------|--------|-----------------|
| Pipeline | `BuilderProps.role` | `codepipeline.amazonaws.com` |
| Step project | `aws:cdk:pipelines:codebuildstep:role` metadata | `codebuild.amazonaws.com` |
| Step action | `aws:cdk:pipelines:codebuildstep:actionrole` metadata | — |

### Secrets Flow

From [secrets-management-ts](../deploy/samples/cdk/secrets-management-ts/):

1. Set `orgId` on `BuilderProps`
2. Plugins declare `secrets: [{ name: 'SECRET_NAME', required: true }]`
3. At deploy, resolves from `pipeline-builder/{orgId}/{secretName}` in Secrets Manager
4. Injected as `SECRETS_MANAGER`-type CodeBuild env vars automatically

---

## Loading Samples

Load all sample pipelines into a running Pipeline Builder instance. By default the script uploads every sample in a single bulk request (validating each `pipeline.json` first), and defaults to `https://localhost:8443`:

```bash
cd deploy
bash bin/load-pipelines.sh

# Custom platform URL
PLATFORM_BASE_URL=https://pipeline.example.com bash bin/load-pipelines.sh

# Validate the sample files without uploading
bash bin/load-pipelines.sh --dry-run

# Upload one at a time via the single-create endpoint (legacy)
bash bin/load-pipelines.sh --single
```

> **Tip:** Samples are also loaded automatically by `init-platform.sh` during [post-deploy setup](aws-deployment.md#post-deploy-steps).
