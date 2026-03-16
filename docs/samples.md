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
| [react-frontend](../deploy/samples/pipelines/react-frontend/) | JS/TS | facebook/react | Lint, Test, Build, Security, Package |
| [spring-boot-java](../deploy/samples/pipelines/spring-boot-java/) | Java | spring-projects/spring-boot | Quality, Build-Test, Coverage, SAST, Publish |
| [django-python](../deploy/samples/pipelines/django-python/) | Python | django/django | Lint, Test, Coverage, Security, Package |
| [gin-golang](../deploy/samples/pipelines/gin-golang/) | Go | gin-gonic/gin | Analysis, Test, Benchmark, Build, Security |
| [axum-rust](../deploy/samples/pipelines/axum-rust/) | Rust | tokio-rs/axum | Lint, Test, Safety, Build, Publish |
| [rails-ruby](../deploy/samples/pipelines/rails-ruby/) | Ruby | rails/rails | Lint, Test-SQLite, Test-PG, Security, Publish |
| [aspnetcore-dotnet](../deploy/samples/pipelines/aspnetcore-dotnet/) | C#/.NET | dotnet/aspnetcore | Analysis, Build-Test, Security, Container, Publish |

### Patterns

- **Plugin filters** — every plugin reference includes `filter` with `version`, `accessModifier`, `isActive`
- **Multi-version testing** — same plugin with different `alias` and `imageTag` (e.g., Java 17 + 21)
- **Failure behavior** — advisory checks use `failureBehavior: "warn"`
- **Step positioning** — primary steps use `"pre"`, supplementary use `"post"`
- **Compute sizing** — heavy steps override to `MEDIUM` or `LARGE` via metadata

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
| Step project | `codebuildstep:role` metadata | `codebuild.amazonaws.com` |
| Step action | `codebuildstep:actionrole` metadata | — |

### Secrets Flow

From [secrets-management-ts](../deploy/samples/cdk/secrets-management-ts/):

1. Set `orgId` on `BuilderProps`
2. Plugins declare `secrets: [{ name: 'SECRET_NAME', required: true }]`
3. At deploy, resolves from `pipeline-builder/{orgId}/{secretName}` in Secrets Manager
4. Injected as `SECRETS_MANAGER`-type CodeBuild env vars automatically

---

## Loading Samples

Load all sample pipelines into a running Pipeline Builder instance:

```bash
cd deploy
bash bin/load-pipelines.sh

# Custom URL
PLATFORM_BASE_URL=https://pipeline.example.com bash bin/load-pipelines.sh
```

> **Tip:** Samples are also loaded automatically by `init-platform.sh` during [post-deploy setup](aws-deployment.md#post-deploy-steps).
