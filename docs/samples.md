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

This catalog indexes the ready-to-use pipeline configs and CDK examples shipped in [`deploy/samples/`](../deploy/samples/). It covers seven language-specific CI/CD pipelines (React, Spring Boot, Django, Gin, Axum, Rails, ASP.NET Core), six `PipelineBuilder` CDK stack examples — VPC isolation, multi-account, monorepo, custom IAM roles, and secrets management — and three CI/CD platform configs (GitHub Actions, GitLab CI/CD, CircleCI) that create and deploy a pipeline in one step, plus how to bulk-load them into a running instance. Use them as starting points for your own pipelines or as reference implementations for advanced patterns.

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

All seven pipelines use a **GitHub (v1/OAuth) source**, which CodePipeline authenticates with an OAuth token in AWS Secrets Manager — **even for public repos**. If the token secret is missing, the deploy fails at pipeline-creation time with `Secrets Manager can't find the specified secret. (ResourceNotFoundException)`.

Each sample resolves the secret **per org** via [synth-time templating](templates.md): its `vars.orgId` feeds the source `token` (`secretsmanager:pipeline-builder/{{ pipeline.vars.orgId }}/github-token`), following the naming standard `pipeline-builder/{orgId}/{name}`. To use a sample:

1. **Set `vars.orgId`** in the sample's `pipeline.json` to your org's ID (the UUID).
2. **Create the matching secret** once per account/region:

```bash
aws secretsmanager create-secret \
  --name "pipeline-builder/<orgId>/github-token" \
  --secret-string "ghp_YOUR_TOKEN_HERE" \
  --region <your-region>
```

Use a PAT with `repo` + `admin:repo_hook` scopes (public repos: `public_repo` + `admin:repo_hook`). `<orgId>` must match the `vars.orgId` you set. **Simpler:** drop the `token` line + `vars` block and create a bare `github-token` secret (CDK's default lookup). **Recommended:** a [CodeStar/CodeConnections](cdk-usage.md#codestar-connection-github-bitbucket-gitlab) source avoids the token entirely.

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

## CI/CD Samples

Ready-to-copy configurations for the major CI/CD platforms that create **and** deploy a pipeline in a single step with [`pipeline-manager pipeline create --deploy`](pipeline-manager.md). `--deploy` creates the pipeline record on the platform, then runs `cdk deploy` for it and registers the deployed CodePipeline ARN — so a green CI run means the pipeline both **exists on the platform** and is **deployed to AWS**.

**Location:** [`deploy/samples/ci/`](../deploy/samples/ci/)

| Sample | Platform | Copy to | AWS auth | Highlight |
|--------|----------|---------|----------|-----------|
| [github-actions](../deploy/samples/ci/github-actions/deploy-pipeline.yml) | GitHub Actions | `.github/workflows/deploy-pipeline.yml` | OIDC role assumption | `workflow_dispatch` with a `props_file` input |
| [gitlab](../deploy/samples/ci/gitlab/.gitlab-ci.yml) | GitLab CI/CD | `.gitlab-ci.yml` | OIDC ID token → STS | `id_tokens` + `assume-role-with-web-identity` |
| [circleci](../deploy/samples/ci/circleci/config.yml) | CircleCI | `.circleci/config.yml` | OIDC token → STS | Context-scoped secrets, `$CIRCLE_OIDC_TOKEN` |

Each sample deploys [`deploy/samples/pipelines/react-javascript/pipeline.json`](../deploy/samples/pipelines/react-javascript/) by default — point `--file` / `PROPS_FILE` at your own [pipeline sample](#pipeline-samples). All three are **idempotent**: re-running with the same config upserts the record (keyed on `project + organization + orgId`), updates the CloudFormation stack, and re-registers the ARN — no duplicates, no errors.

### Shared requirements

- **Toolchain** (every sample installs it): Node 24+, plus `pipeline-manager`, `aws-cdk`, `esbuild`, and `pnpm` on `PATH` — `--deploy` shells out to `cdk deploy`, whose synth uses esbuild + pnpm.
- **Platform auth** (CI secrets): `PLATFORM_BASE_URL` and `PLATFORM_TOKEN` (a Personal Access Token from `pipeline-manager auth pat` or the dashboard).
- **AWS auth**: each platform's OIDC federation assumes a deploy role — the role ARN is stored as a CI secret (`AWS_DEPLOY_ROLE_ARN`), never committed. Each sample notes the one-line swap to static access keys.
- **Region** via `AWS_REGION` (or `--region`); otherwise resolves `AWS_REGION` → `CDK_DEFAULT_REGION` → `us-east-1`.

### GitHub Actions

[`github-actions/deploy-pipeline.yml`](../deploy/samples/ci/github-actions/deploy-pipeline.yml) — triggered manually via `workflow_dispatch` (with an optional `props_file` input) and includes a commented `push` trigger. Requests `id-token: write` and assumes `AWS_DEPLOY_ROLE_ARN` with [`aws-actions/configure-aws-credentials`](https://github.com/aws-actions/configure-aws-credentials), so no long-lived keys are stored. `PLATFORM_BASE_URL` / `PLATFORM_TOKEN` come from Actions secrets.

### GitLab CI/CD

[`gitlab/.gitlab-ci.yml`](../deploy/samples/ci/gitlab/.gitlab-ci.yml) — a single `deploy`-stage job on the `node:24` image. It mints a GitLab OIDC ID token (`id_tokens`), exchanges it for temporary AWS credentials with `aws sts assume-role-with-web-identity`, and runs the create-and-deploy in `script:`. Runs on manual (`web`) pipelines by default, with a commented rule to deploy on pushes to `main`.

### CircleCI

[`circleci/config.yml`](../deploy/samples/ci/circleci/config.yml) — a `create-and-deploy` job on `cimg/node:24.14` wired to a **context** (e.g. `pipeline-builder-deploy`) that holds the secrets. It exchanges `$CIRCLE_OIDC_TOKEN` for temporary AWS credentials via STS (written to `$BASH_ENV`) before running the deploy step.

### Exit codes

`pipeline-manager` returns [standard exit codes](pipeline-manager.md) so CI fails on the right things: `0` success · `2` validation · `3` API request · `4` authentication · `5` authorization · `6` not found · `7` network · `8` configuration · `10` timeout. If create succeeds but the deploy fails, the command exits non-zero and prints `pipeline-manager pipeline deploy --id <id>` so you can retry the deploy without recreating the record.

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
