---
layout: default
title: Samples
---

<!--
Copyright 2026 Pipeline Builder Contributors
SPDX-License-Identifier: Apache-2.0
-->

# Samples

Ready-to-use pipeline templates, CDK stack examples and CI/CD configurations. Use them as starting points for your own pipelines, or as reference implementations for advanced patterns.

Everything indexed here lives in [`deploy/samples/`](https://github.com/mwashburn160/pipeline-builder/tree/main/deploy/samples).

## Highlights

- **A template is not a pipeline.** You *instantiate* it with declared inputs to get concrete pipeline `props`, then create the pipeline from those.
- **Instantiation only renders.** The returned props go through the normal create path, so compliance and quota still apply.
- **All seven templates need a GitHub OAuth token in Secrets Manager — even for public repos.** Without it the deploy fails at pipeline-creation time. A [CodeStar connection](cdk-usage.md#codestar-connection-github-bitbucket-gitlab) avoids the token entirely.
- **`orgId` is the one declared input**, because the source `token` is the only source field that is synth-templatable. Fork a template to point at your own repository.
- **The CI samples are idempotent.** Re-running upserts the record, updates the CloudFormation stack and refreshes the registry row — no duplicates, no errors.
- **Templates land in the reserved `system` org as `public`**, so every logged-in org sees them in the golden-path catalog.

## Overview

Three kinds of sample, for three different jobs:

| Kind | Count | Use it to |
|---|---|---|
| **Pipeline templates** | 7 languages — React, Spring Boot, Django, Gin, Axum, Rails, ASP.NET Core | Get a working pipeline for a stack you recognize, then extend it |
| **CDK stack examples** | 6 patterns — VPC isolation, multi-account, monorepo, custom IAM roles, secrets management, basic | Learn `PipelineBuilder` usage for a pattern you need to build by hand |
| **CI/CD configurations** | 3 platforms — GitHub Actions, GitLab CI/CD, CircleCI | Instantiate a template and deploy the resulting pipeline in one CI run |

Each template is intentionally minimal — a build and/or security-scan stage — which you extend with tests, linting and container packaging. Every sample directory has its own README with that guidance.

## How it works

1. **The templates are loaded into a running instance.** Each `template.json` is POSTed to `/api/pipeline-templates`, landing in the `system` org as `public`.
2. **You instantiate one**, supplying its declared inputs. The server renders the template body, baking the inputs into `props.vars`.
3. **Nothing is created yet.** Instantiation returns props; the pipeline does not exist.
4. **You create the pipeline from those props**, through the normal create path — so compliance validation and quota apply exactly as they would to a hand-written pipeline.
5. **`--deploy` also deploys it.** The pipeline record is created on the platform, `cdk deploy` runs for it, and the deployed stack is registered by name plus region — never the ARN, which embeds the AWS account id.
6. **At deploy time, secrets resolve per org.** Plugins declaring `secrets: [...]` get them from `pipeline-builder/{orgId}/{secretName}` in Secrets Manager, injected as `SECRETS_MANAGER`-type CodeBuild environment variables.

## Configuration

### 1. Load the templates

```bash
cd deploy
bash bin/load-templates.sh

# Custom platform URL
PLATFORM_BASE_URL=https://pipeline.example.com bash bin/load-templates.sh

# Validate the template files without uploading
bash bin/load-templates.sh --dry-run
```

There is no bulk template endpoint — the script POSTs each file — and it defaults to `https://localhost:8443`. A name that already exists comes back as HTTP 409 and is reported as `SKIP`, so re-running the loader is safe.

> **Tip:** `init-platform.sh` loads the samples for you during [post-deploy setup](aws-deployment.md#post-deploy-steps) (`LOAD_TEMPLATES=y`).

### 2. Create the GitHub source token

All seven templates use a **GitHub (v1/OAuth) source**, which CodePipeline authenticates with an OAuth token in AWS Secrets Manager — **even for public repos**. If the token secret is missing, the deploy fails at pipeline-creation time with:

```
Secrets Manager can't find the specified secret. (ResourceNotFoundException)
```

Each template resolves the secret **per org** via [synth-time templating](templates.md): its declared `orgId` input feeds the source `token` as `secretsmanager:pipeline-builder/{{ pipeline.vars.orgId }}/github-token`, following the naming standard `pipeline-builder/{orgId}/{name}`.

1. **Pass your org's UUID as the `orgId` input** when you instantiate.
2. **Create the matching secret** once per account/region:

   ```bash
   aws secretsmanager create-secret \
     --name "pipeline-builder/<orgId>/github-token" \
     --secret-string "ghp_YOUR_TOKEN_HERE" \
     --region <your-region>
   ```

Use a PAT with `repo` + `admin:repo_hook` scopes (public repos: `public_repo` + `admin:repo_hook`). `<orgId>` must match the `orgId` input you pass.

Two alternatives:

- **Simpler** — drop the `token` line from `props.synth.source.options` and create a bare `github-token` secret, which is CDK's default lookup.
- **Recommended** — use a [CodeStar/CodeConnections](cdk-usage.md#codestar-connection-github-bitbucket-gitlab) source and skip the token entirely.

### 3. Instantiate and deploy

```bash
pipeline-manager template instantiate \
  --name react-javascript \
  --project react --organization AcmeCorp \
  --input orgId=<your-org-id> \
  --output pipeline-props.json

pipeline-manager pipeline create --file pipeline-props.json --deploy --region us-east-1
```

`--name` resolves against the catalog you can see and refuses to guess when the name is missing or matches more than one visible template; pass `--id` to pick one explicitly. Repeat `--input k=v` per declared input, or pass a JSON `--inputs-file` that `--input` flags override. Without `--output` the props go to stdout; `--json` suppresses all decorative output so the stream pipes cleanly into `jq`. Full flag reference: [`pipeline-manager template instantiate --help`](pipeline-manager.md#command-reference).

Or pick the template from the dashboard's golden-path catalog and fill in the inputs there.

### 4. For a CI run, set the secrets

- **Platform auth:** `PLATFORM_BASE_URL`, `PLATFORM_TOKEN` (an access key from `pipeline-manager auth pat` or the dashboard), and `PB_ORG_ID` (your org's UUID, passed as the template's `orgId` input).
- **AWS auth:** each platform's OIDC federation assumes a deploy role whose ARN is stored as a CI secret (`AWS_DEPLOY_ROLE_ARN`), never committed. Each sample notes the one-line swap to static access keys.
- **Region:** `AWS_REGION` (or `--region`); otherwise resolves `AWS_REGION` → `CDK_DEFAULT_REGION` → `us-east-1`.
- **Toolchain** (every sample installs it): Node 24+, plus `pipeline-manager`, `aws-cdk`, `esbuild` and `pnpm` on `PATH` — `--deploy` shells out to `cdk deploy`, whose synth uses esbuild and pnpm. The instantiate step needs nothing extra.

## Pipeline template samples

**Location:** [`deploy/samples/templates/`](https://github.com/mwashburn160/pipeline-builder/tree/main/deploy/samples/templates)

| Template | Language | Source Repo | Stages |
|----------|----------|-------------|--------|
| [react-javascript](https://github.com/mwashburn160/pipeline-builder/tree/main/deploy/samples/templates/react-javascript) | JS/TS | sitek94/vite-deploy-demo | Build, Security |
| [spring-boot-java](https://github.com/mwashburn160/pipeline-builder/tree/main/deploy/samples/templates/spring-boot-java) | Java | dstar55/docker-hello-world-spring-boot | Build |
| [django-python](https://github.com/mwashburn160/pipeline-builder/tree/main/deploy/samples/templates/django-python) | Python | django-ve/django-helloworld | Security |
| [gin-golang](https://github.com/mwashburn160/pipeline-builder/tree/main/deploy/samples/templates/gin-golang) | Go | lamhotsimamora/Hello-World-Golang-Gin | Build, Security |
| [axum-rust](https://github.com/mwashburn160/pipeline-builder/tree/main/deploy/samples/templates/axum-rust) | Rust | ChiefTechDev/Rust-Axum-Hello-World | Build, Security |
| [rails-ruby](https://github.com/mwashburn160/pipeline-builder/tree/main/deploy/samples/templates/rails-ruby) | Ruby | m9rc1n/hello-world-rails | Security |
| [aspnetcore-dotnet](https://github.com/mwashburn160/pipeline-builder/tree/main/deploy/samples/templates/aspnetcore-dotnet) | C#/.NET | Azure-Samples/dotnetcore-docs-hello-world | Build, Security |

### Anatomy of a `template.json`

| Field | Meaning |
|-------|---------|
| `name` | Unique per org — the handle you look the template up by |
| `description`, `keywords`, `category` | Catalog metadata for search and grouping |
| `visibility` | `private` \| `org` \| `public`. The loader forces `public` so the seeded catalog is readable from every org |
| `inputs[]` | Declared parameters; each becomes a `vars.<name>` key on the generated pipeline |
| `props` | The pipeline body (`BuilderProps`) with `{{ pipeline.vars.* }}` placeholders |

`props` deliberately omits `project`, `organization` and `vars` — instantiation supplies all three from the request, so there is nothing to hand-edit.

### Patterns worth copying

- **Plugin filters** — every plugin reference includes a `filter` (`version`, `visibility`, `isActive`, `isDefault`) so the resolved plugin version is explicit and reproducible.
- **Failure behavior** — advisory checks such as dependency audits use `failureBehavior: "warn"` so they report findings without failing the build.
- **Step positioning** — primary steps use `"pre"`, supplementary steps use `"post"`.
- **Compute sizing** — heavier steps override the default compute to `MEDIUM` or `LARGE` via the `aws:cdk:codebuild:buildenvironment:computetype` metadata key.

## CDK TypeScript examples

Self-contained stack classes showing `PipelineBuilder` usage.

**Location:** [`deploy/samples/cdk/`](https://github.com/mwashburn160/pipeline-builder/tree/main/deploy/samples/cdk)

| Sample | Pattern |
|--------|---------|
| [basic-pipeline-ts](https://github.com/mwashburn160/pipeline-builder/tree/main/deploy/samples/cdk/basic-pipeline-ts) | Simplest usage — GitHub source, plugin filters, 4 stages |
| [vpc-isolated-pipeline-ts](https://github.com/mwashburn160/pipeline-builder/tree/main/deploy/samples/cdk/vpc-isolated-pipeline-ts) | VPC networking with `NetworkConfig` and step-level overrides |
| [multi-account-pipeline-ts](https://github.com/mwashburn160/pipeline-builder/tree/main/deploy/samples/cdk/multi-account-pipeline-ts) | Cross-account with `RoleConfig`, CodeStar source, ManualApproval |
| [monorepo-pipeline-ts](https://github.com/mwashburn160/pipeline-builder/tree/main/deploy/samples/cdk/monorepo-pipeline-ts) | Monorepo with factory functions, pnpm workspace, per-service Docker |
| [custom-iam-roles-ts](https://github.com/mwashburn160/pipeline-builder/tree/main/deploy/samples/cdk/custom-iam-roles-ts) | Three levels of IAM role control (pipeline, step project, step action) |
| [secrets-management-ts](https://github.com/mwashburn160/pipeline-builder/tree/main/deploy/samples/cdk/secrets-management-ts) | Secrets Manager integration with `orgId`-scoped resolution |

### The three IAM role levels

From [custom-iam-roles-ts](https://github.com/mwashburn160/pipeline-builder/tree/main/deploy/samples/cdk/custom-iam-roles-ts):

| Level | Config | Trust Principal |
|-------|--------|-----------------|
| Pipeline | `BuilderProps.role` | `codepipeline.amazonaws.com` |
| Step project | `aws:cdk:pipelines:codebuildstep:role` metadata | `codebuild.amazonaws.com` |
| Step action | `aws:cdk:pipelines:codebuildstep:actionrole` metadata | — |

### The secrets flow

From [secrets-management-ts](https://github.com/mwashburn160/pipeline-builder/tree/main/deploy/samples/cdk/secrets-management-ts):

1. Set `orgId` on `BuilderProps`.
2. Plugins declare `secrets: [{ name: 'SECRET_NAME', required: true }]`.
3. At deploy, the value resolves from `pipeline-builder/{orgId}/{secretName}` in Secrets Manager.
4. It is injected as a `SECRETS_MANAGER`-type CodeBuild environment variable automatically.

## CI/CD samples

Ready-to-copy configurations that instantiate a pipeline template, then create **and** deploy the resulting pipeline with [`pipeline-manager pipeline create --deploy`](pipeline-manager.md). A green CI run therefore means the pipeline both **exists on the platform** and is **deployed to AWS**.

**Location:** [`deploy/samples/ci/`](https://github.com/mwashburn160/pipeline-builder/tree/main/deploy/samples/ci)

| Sample | Platform | Copy to | AWS auth | Highlight |
|--------|----------|---------|----------|-----------|
| [github-actions](https://github.com/mwashburn160/pipeline-builder/blob/main/deploy/samples/ci/github-actions/deploy-pipeline.yml) | GitHub Actions | `.github/workflows/deploy-pipeline.yml` | OIDC role assumption | `workflow_dispatch` with `template_name` / `project` / `organization` inputs |
| [gitlab](https://github.com/mwashburn160/pipeline-builder/blob/main/deploy/samples/ci/gitlab/.gitlab-ci.yml) | GitLab CI/CD | `.gitlab-ci.yml` | OIDC ID token → STS | `id_tokens` + `assume-role-with-web-identity` |
| [circleci](https://github.com/mwashburn160/pipeline-builder/blob/main/deploy/samples/ci/circleci/config.yml) | CircleCI | `.circleci/config.yml` | OIDC token → STS | Context-scoped secrets, `$CIRCLE_OIDC_TOKEN` |

Each sample instantiates the [`react-javascript`](https://github.com/mwashburn160/pipeline-builder/tree/main/deploy/samples/templates/react-javascript) template by default — set `TEMPLATE_NAME` (plus `PB_PROJECT` / `PB_ORGANIZATION`) to any other [template](#pipeline-template-samples) in your catalog. Instantiation reads the platform's live catalog, so the template must already be loaded there.

All three are **idempotent**: re-running with the same config upserts the record (keyed on `project + organization + orgId`), updates the CloudFormation stack and refreshes the registry row.

### GitHub Actions

[`github-actions/deploy-pipeline.yml`](https://github.com/mwashburn160/pipeline-builder/blob/main/deploy/samples/ci/github-actions/deploy-pipeline.yml) — triggered manually via `workflow_dispatch` (with `template_name`, `project` and `organization` inputs), and includes a commented `push` trigger. It requests `id-token: write` and assumes `AWS_DEPLOY_ROLE_ARN` with [`aws-actions/configure-aws-credentials`](https://github.com/aws-actions/configure-aws-credentials), so no long-lived keys are stored. `PLATFORM_BASE_URL` / `PLATFORM_TOKEN` come from Actions secrets.

### GitLab CI/CD

[`gitlab/.gitlab-ci.yml`](https://github.com/mwashburn160/pipeline-builder/blob/main/deploy/samples/ci/gitlab/.gitlab-ci.yml) — a single `deploy`-stage job on the `node:24` image. It mints a GitLab OIDC ID token (`id_tokens`), exchanges it for temporary AWS credentials with `aws sts assume-role-with-web-identity`, and runs the instantiate plus create-and-deploy steps in `script:`. Runs on manual (`web`) pipelines by default, with a commented rule to deploy on pushes to `main`.

### CircleCI

[`circleci/config.yml`](https://github.com/mwashburn160/pipeline-builder/blob/main/deploy/samples/ci/circleci/config.yml) — a `create-and-deploy` job on `cimg/node:24.21` wired to a **context** (e.g. `pipeline-builder-deploy`) that holds the secrets. It exchanges `$CIRCLE_OIDC_TOKEN` for temporary AWS credentials via STS (written to `$BASH_ENV`) before the instantiate and deploy steps.

### Exit codes

`pipeline-manager` returns [standard exit codes](pipeline-manager.md) so CI fails on the right things:

`0` success · `2` validation · `3` API request · `4` authentication · `5` authorization · `6` not found · `7` network · `8` configuration · `10` timeout

If create succeeds but the deploy fails, the command exits non-zero and prints `pipeline-manager pipeline deploy --id <id>` so you can retry the deploy without recreating the record.

## Related

- [Plugin Catalog](plugins/README.md) — the plugins these templates reference
- [Metadata Keys](metadata-keys.md) — the typed keys the samples set
- [Template Syntax](templates.md) — the `{{ ... }}` grammar templates are written in
- [CDK Usage](cdk-usage.md) — the `PipelineBuilder` construct the CDK samples use
- [Pipeline Manager](pipeline-manager.md) — the CLI the samples drive
- [API Reference](api-reference.md) — the endpoints behind them
