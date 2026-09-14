---
layout: default
title: Samples
---

# Samples

Ready-to-use pipeline templates and CDK examples that demonstrate Pipeline Builder's capabilities. Use these as starting points for your own pipelines or as reference implementations for advanced patterns.

All sample files are located in [`deploy/samples/`](https://github.com/mwashburn160/pipeline-builder/tree/main/deploy/samples).

**Related docs:** [Plugin Catalog](plugins/README.md) | [Metadata Keys](metadata-keys.md) | [API Reference](api-reference.md)

---

## Overview

This catalog indexes the ready-to-use pipeline templates and CDK examples shipped in [`deploy/samples/`](https://github.com/mwashburn160/pipeline-builder/tree/main/deploy/samples). It covers seven language-specific golden-path templates (React, Spring Boot, Django, Gin, Axum, Rails, ASP.NET Core), six `PipelineBuilder` CDK stack examples — VPC isolation, multi-account, monorepo, custom IAM roles, and secrets management — and three CI/CD platform configs (GitHub Actions, GitLab CI/CD, CircleCI) that instantiate a template and deploy the resulting pipeline in one run, plus how to load the templates into a running instance. Use them as starting points for your own pipelines or as reference implementations for advanced patterns.

---

## Pipeline Template Samples

Language-specific golden-path **pipeline templates** built on small, real hello-world repos. A template is a parameterized starting point, not a pipeline: you *instantiate* it with declared inputs to get concrete pipeline `props`, then create the pipeline from those. Each sample is intentionally minimal — a build and/or security-scan stage — that you extend with tests, linting, and container packaging (see each sample's README).

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

`props` deliberately omits `project`, `organization`, and `vars` — instantiation supplies all three from the request, so there is nothing to hand-edit.

### Prerequisite: GitHub source token

All seven templates use a **GitHub (v1/OAuth) source**, which CodePipeline authenticates with an OAuth token in AWS Secrets Manager — **even for public repos**. If the token secret is missing, the deploy fails at pipeline-creation time with `Secrets Manager can't find the specified secret. (ResourceNotFoundException)`.

Each template resolves the secret **per org** via [synth-time templating](templates.md): its declared `orgId` input feeds the source `token` (`secretsmanager:pipeline-builder/{{ pipeline.vars.orgId }}/github-token`), following the naming standard `pipeline-builder/{orgId}/{name}`. `orgId` is each sample's one declared input, because the source `token` is the only source field that is synth-templatable — `repo`/`branch` stay literal, so fork a template and edit `props.synth.source.options` to point at your own repository. To use a template:

1. **Pass your org's ID (the UUID) as the `orgId` input** when you instantiate.
2. **Create the matching secret** once per account/region:

```bash
aws secretsmanager create-secret \
  --name "pipeline-builder/<orgId>/github-token" \
  --secret-string "ghp_YOUR_TOKEN_HERE" \
  --region <your-region>
```

Use a PAT with `repo` + `admin:repo_hook` scopes (public repos: `public_repo` + `admin:repo_hook`). `<orgId>` must match the `orgId` input you pass. **Simpler:** drop the `token` line from `props.synth.source.options` and create a bare `github-token` secret (CDK's default lookup). **Recommended:** a [CodeStar/CodeConnections](cdk-usage.md#codestar-connection-github-bitbucket-gitlab) source avoids the token entirely.

### Instantiating a template

Instantiation only *renders* — it creates nothing. The returned props go through the normal create path, so compliance and quota still apply.

```bash
pipeline-manager template instantiate \
  --name react-javascript \
  --project react --organization AcmeCorp \
  --input orgId=<your-org-id> \
  --output pipeline-props.json

pipeline-manager pipeline create --file pipeline-props.json --deploy --region us-east-1
```

`--name` resolves against the catalog you can see and refuses to guess when the name is missing or matches more than one visible template; pass `--id` to pick one explicitly. Repeat `--input k=v` per declared input (or pass a JSON `--inputs-file`, which `--input` flags override). Without `--output` the props go to stdout; `--json` suppresses all decorative output so the stream pipes cleanly into `jq`. Full flag reference: [`pipeline-manager template instantiate --help`](pipeline-manager.md#command-reference).

Or pick the template from the dashboard's golden-path catalog and fill in the inputs there.

### Patterns

- **Plugin filters** — every plugin reference includes a `filter` (`version`, `visibility`, `isActive`, `isDefault`) so the resolved plugin version is explicit and reproducible
- **Failure behavior** — advisory checks (e.g. dependency audits) use `failureBehavior: "warn"` so they report findings without failing the build
- **Step positioning** — primary steps use `"pre"`, supplementary steps use `"post"`
- **Compute sizing** — heavier steps override the default compute to `MEDIUM` or `LARGE` via the `aws:cdk:codebuild:buildenvironment:computetype` metadata key

---

## CDK TypeScript Examples

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

### IAM Role Levels

From [custom-iam-roles-ts](https://github.com/mwashburn160/pipeline-builder/tree/main/deploy/samples/cdk/custom-iam-roles-ts):

| Level | Config | Trust Principal |
|-------|--------|-----------------|
| Pipeline | `BuilderProps.role` | `codepipeline.amazonaws.com` |
| Step project | `aws:cdk:pipelines:codebuildstep:role` metadata | `codebuild.amazonaws.com` |
| Step action | `aws:cdk:pipelines:codebuildstep:actionrole` metadata | — |

### Secrets Flow

From [secrets-management-ts](https://github.com/mwashburn160/pipeline-builder/tree/main/deploy/samples/cdk/secrets-management-ts):

1. Set `orgId` on `BuilderProps`
2. Plugins declare `secrets: [{ name: 'SECRET_NAME', required: true }]`
3. At deploy, resolves from `pipeline-builder/{orgId}/{secretName}` in Secrets Manager
4. Injected as `SECRETS_MANAGER`-type CodeBuild env vars automatically

---

## CI/CD Samples

Ready-to-copy configurations for the major CI/CD platforms that instantiate a pipeline template, then create **and** deploy the resulting pipeline with [`pipeline-manager pipeline create --deploy`](pipeline-manager.md). `--deploy` creates the pipeline record on the platform, then runs `cdk deploy` for it and registers the deployed stack (by name + region — never the ARN, which embeds the AWS account id) — so a green CI run means the pipeline both **exists on the platform** and is **deployed to AWS**.

**Location:** [`deploy/samples/ci/`](https://github.com/mwashburn160/pipeline-builder/tree/main/deploy/samples/ci)

| Sample | Platform | Copy to | AWS auth | Highlight |
|--------|----------|---------|----------|-----------|
| [github-actions](https://github.com/mwashburn160/pipeline-builder/blob/main/deploy/samples/ci/github-actions/deploy-pipeline.yml) | GitHub Actions | `.github/workflows/deploy-pipeline.yml` | OIDC role assumption | `workflow_dispatch` with `template_name` / `project` / `organization` inputs |
| [gitlab](https://github.com/mwashburn160/pipeline-builder/blob/main/deploy/samples/ci/gitlab/.gitlab-ci.yml) | GitLab CI/CD | `.gitlab-ci.yml` | OIDC ID token → STS | `id_tokens` + `assume-role-with-web-identity` |
| [circleci](https://github.com/mwashburn160/pipeline-builder/blob/main/deploy/samples/ci/circleci/config.yml) | CircleCI | `.circleci/config.yml` | OIDC token → STS | Context-scoped secrets, `$CIRCLE_OIDC_TOKEN` |

Each sample instantiates the [`react-javascript`](https://github.com/mwashburn160/pipeline-builder/tree/main/deploy/samples/templates/react-javascript) template by default — set `TEMPLATE_NAME` (plus `PB_PROJECT` / `PB_ORGANIZATION`) to any other [template](#pipeline-template-samples) in your catalog. Instantiation reads the platform's live catalog, so the template must already be loaded there. All three are **idempotent**: re-running with the same config upserts the record (keyed on `project + organization + orgId`), updates the CloudFormation stack, and refreshes the registry row — no duplicates, no errors.

### Shared requirements

- **Toolchain** (every sample installs it): Node 24+, plus `pipeline-manager`, `aws-cdk`, `esbuild`, and `pnpm` on `PATH` — `--deploy` shells out to `cdk deploy`, whose synth uses esbuild + pnpm. The instantiate step needs nothing extra — it runs through the same CLI.
- **Platform auth** (CI secrets): `PLATFORM_BASE_URL`, `PLATFORM_TOKEN` (a Personal Access Token from `pipeline-manager auth pat` or the dashboard), and `PB_ORG_ID` (your org's UUID, passed as the template's `orgId` input).
- **AWS auth**: each platform's OIDC federation assumes a deploy role — the role ARN is stored as a CI secret (`AWS_DEPLOY_ROLE_ARN`), never committed. Each sample notes the one-line swap to static access keys.
- **Region** via `AWS_REGION` (or `--region`); otherwise resolves `AWS_REGION` → `CDK_DEFAULT_REGION` → `us-east-1`.

### GitHub Actions

[`github-actions/deploy-pipeline.yml`](https://github.com/mwashburn160/pipeline-builder/blob/main/deploy/samples/ci/github-actions/deploy-pipeline.yml) — triggered manually via `workflow_dispatch` (with `template_name`, `project`, and `organization` inputs) and includes a commented `push` trigger. Requests `id-token: write` and assumes `AWS_DEPLOY_ROLE_ARN` with [`aws-actions/configure-aws-credentials`](https://github.com/aws-actions/configure-aws-credentials), so no long-lived keys are stored. `PLATFORM_BASE_URL` / `PLATFORM_TOKEN` come from Actions secrets.

### GitLab CI/CD

[`gitlab/.gitlab-ci.yml`](https://github.com/mwashburn160/pipeline-builder/blob/main/deploy/samples/ci/gitlab/.gitlab-ci.yml) — a single `deploy`-stage job on the `node:24` image. It mints a GitLab OIDC ID token (`id_tokens`), exchanges it for temporary AWS credentials with `aws sts assume-role-with-web-identity`, and runs the instantiate + create-and-deploy steps in `script:`. Runs on manual (`web`) pipelines by default, with a commented rule to deploy on pushes to `main`.

### CircleCI

[`circleci/config.yml`](https://github.com/mwashburn160/pipeline-builder/blob/main/deploy/samples/ci/circleci/config.yml) — a `create-and-deploy` job on `cimg/node:24.14` wired to a **context** (e.g. `pipeline-builder-deploy`) that holds the secrets. It exchanges `$CIRCLE_OIDC_TOKEN` for temporary AWS credentials via STS (written to `$BASH_ENV`) before the instantiate and deploy steps.

### Exit codes

`pipeline-manager` returns [standard exit codes](pipeline-manager.md) so CI fails on the right things: `0` success · `2` validation · `3` API request · `4` authentication · `5` authorization · `6` not found · `7` network · `8` configuration · `10` timeout. If create succeeds but the deploy fails, the command exits non-zero and prints `pipeline-manager pipeline deploy --id <id>` so you can retry the deploy without recreating the record.

---

## Loading Samples

Load all sample templates into a running Pipeline Builder instance. Each `template.json` is POSTed to `/api/pipeline-templates` (there is no bulk template endpoint), and the script defaults to `https://localhost:8443`:

```bash
cd deploy
bash bin/load-templates.sh

# Custom platform URL
PLATFORM_BASE_URL=https://pipeline.example.com bash bin/load-templates.sh

# Validate the template files without uploading
bash bin/load-templates.sh --dry-run
```

Templates land in the reserved `system` org as `public`, so every logged-in org sees them in the golden-path catalog. A name that already exists comes back as HTTP 409 and is reported as `SKIP`, so re-running the loader is safe.

> **Tip:** Samples are also loaded automatically by `init-platform.sh` during [post-deploy setup](aws-deployment.md#post-deploy-steps) (`LOAD_TEMPLATES=y`).
