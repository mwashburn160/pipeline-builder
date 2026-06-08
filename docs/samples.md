---
layout: default
title: Samples
---

# Samples

Ready-to-use pipeline configurations and CDK examples that demonstrate Pipeline Builder's capabilities. Use these as starting points for your own pipelines or as reference implementations for advanced patterns.

All sample files are located in [`deploy/samples/`](../deploy/samples/).

**Related docs:** [Plugin Catalog](plugins/README.md) | [Metadata Keys](metadata-keys.md) | [API Reference](api-reference.md)

---

## Pipeline Samples

Language-specific CI/CD pipelines based on well-known open source repos. Each sample demonstrates idiomatic build, test, security, and packaging stages for its language.

**Location:** [`deploy/samples/pipelines/`](../deploy/samples/pipelines/)

| Sample | Language | Source Repo | Stages |
|--------|----------|-------------|--------|
| [react-javascript](../deploy/samples/pipelines/react-javascript/) | JS/TS | facebook/react | Build, Test, Lint, Security, Publish |
| [spring-boot-java](../deploy/samples/pipelines/spring-boot-java/) | Java | spring-projects/spring-boot | Build, Test, Lint, Security |
| [django-python](../deploy/samples/pipelines/django-python/) | Python | django/django | Test, Lint, Security, Publish |
| [gin-golang](../deploy/samples/pipelines/gin-golang/) | Go | gin-gonic/gin | Build, Test, Lint, Security |
| [axum-rust](../deploy/samples/pipelines/axum-rust/) | Rust | tokio-rs/axum | Build, Test, Lint, Security, Publish |
| [rails-ruby](../deploy/samples/pipelines/rails-ruby/) | Ruby | rails/rails | Test, Lint, Security, Publish |
| [aspnetcore-dotnet](../deploy/samples/pipelines/aspnetcore-dotnet/) | C#/.NET | dotnet/aspnetcore | Build, Test, Lint, Security, Publish |

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
