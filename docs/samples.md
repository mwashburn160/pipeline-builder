# Sample Pipelines & CDK Examples

Ready-to-use pipeline configurations and CDK TypeScript examples demonstrating Pipeline Builder's capabilities. All samples are located in [`deploy/samples/`](../deploy/samples/).

---

## Pipeline Samples

Language-specific CI/CD pipelines based on well-known open source repositories. Each includes multiple stages with multiple plugins, plugin filter criteria, and language-appropriate tooling.

**Location:** [`deploy/samples/pipelines/`](../deploy/samples/pipelines/)

| Sample | Language | Source Repo | Stages | Description |
|--------|----------|-------------|--------|-------------|
| [react-frontend](../deploy/samples/pipelines/react-frontend/) | JavaScript / TypeScript | facebook/react | Lint, Unit-Test, Build, Security, Package | Yarn-based pipeline with ESLint, Prettier, Jest (80% coverage), Snyk, npm publish |
| [spring-boot-java](../deploy/samples/pipelines/spring-boot-java/) | Java | spring-projects/spring-boot | Quality, Build-Test, Coverage, SAST, Publish | Multi-JDK testing (17 + 21), Checkstyle, SpotBugs, JaCoCo, SonarCloud, OWASP, Maven publish |
| [django-python](../deploy/samples/pipelines/django-python/) | Python | django/django | Lint, Unit-Test, Coverage, Security, Package | Multi-Python testing (3.11 + 3.12), Ruff, mypy, Bandit, Safety, PyPI publish |
| [gin-golang](../deploy/samples/pipelines/gin-golang/) | Go | gin-gonic/gin | Static-Analysis, Test, Benchmark, Build, Security | golangci-lint, race detector, benchmarks, static binary build, Trivy, gosec |
| [axum-rust](../deploy/samples/pipelines/axum-rust/) | Rust | tokio-rs/axum | Lint, Test, Safety, Build, Publish | Clippy, rustfmt, Miri, cargo-audit, MSRV testing (1.75), release build, crates.io publish |
| [rails-ruby](../deploy/samples/pipelines/rails-ruby/) | Ruby | rails/rails | Lint, Test-SQLite, Test-PostgreSQL, Security, Publish | Multi-database testing (SQLite, PostgreSQL, MySQL), Brakeman, bundler-audit, RubyGems publish |
| [aspnetcore-dotnet](../deploy/samples/pipelines/aspnetcore-dotnet/) | C# / .NET | dotnet/aspnetcore | Analysis, Build-Test, Security, Container, Publish | Roslyn analyzers, multi-TFM testing (.NET 8 + 9), container scanning, NuGet publish |

### Common Patterns Across Pipelines

- **Plugin filters** — every plugin reference includes `filter` with `version`, `accessModifier`, `isActive`, and optionally `isDefault` and `imageTag`
- **Multi-version testing** — same plugin used twice with different `alias` and `imageTag` values (e.g., Java 17 + 21, Python 3.11 + 3.12)
- **Failure behavior** — secondary checks use `failureBehavior: "warn"` to avoid blocking on advisory-only results
- **Step positioning** — primary steps use `position: "pre"`, supplementary/reporting steps use `"post"`
- **Compute sizing** — compilation-heavy steps override to `MEDIUM` or `LARGE` via metadata

---

## CDK Infrastructure Samples (JSON)

Pipeline configurations demonstrating advanced CDK infrastructure patterns like VPC networking, cross-account deployment, S3 sources, and multi-region rollout.

**Location:** [`deploy/samples/cdk/`](../deploy/samples/cdk/)

| Sample | Pattern | Key Features |
|--------|---------|--------------|
| [vpc-private-network](../deploy/samples/cdk/vpc-private-network/) | VPC-isolated builds | Pipeline-level `defaults.network` (vpcId), step-level `subnetIds` override, security group IDs, integration testing against internal services |
| [cross-account-deployment](../deploy/samples/cdk/cross-account-deployment/) | Multi-account governance | Cross-account KMS keys, IAM `roleArn`, CodeStar source, ManualApprovalStep gate, tenant `orgId` for secrets |
| [s3-source-enterprise](../deploy/samples/cdk/s3-source-enterprise/) | S3 artifact-triggered | S3 poll source, VPC `vpcLookup` by tags, IAM `roleName`, CloudFormation change sets, synth command hooks |
| [codestar-multi-region](../deploy/samples/cdk/codestar-multi-region/) | Global multi-region deploy | 3-region deployment (us-east-1, eu-west-1, ap-southeast-1), `securityGroupLookup` by name, cross-region stack reuse |

---

## CDK TypeScript Examples

TypeScript code examples showing how to use `PipelineBuilder` programmatically inside CDK stacks. Each file is a self-contained stack class.

**Location:** [`deploy/samples/cdk/`](../deploy/samples/cdk/)

| Sample | File | Pattern | Key Features |
|--------|------|---------|--------------|
| [basic-pipeline-ts](../deploy/samples/cdk/basic-pipeline-ts/) | `pipeline-stack.ts` | Simplest usage | `PipelineBuilder` in a Stack, GitHub source, plugin filters, 4 stages |
| [vpc-isolated-pipeline-ts](../deploy/samples/cdk/vpc-isolated-pipeline-ts/) | `pipeline-stack.ts` | VPC networking | `CodeBuildDefaults` with `NetworkConfig` and `SecurityGroupConfig`, step-level network override |
| [multi-account-pipeline-ts](../deploy/samples/cdk/multi-account-pipeline-ts/) | `pipeline-stack.ts` | Cross-account governance | `RoleConfig`, CodeStar source, ManualApprovalStep, helper function for deploy stages |
| [monorepo-pipeline-ts](../deploy/samples/cdk/monorepo-pipeline-ts/) | `pipeline-stack.ts` | Monorepo workspace | Factory functions for steps, `codeBuildCloneOutput`, pnpm workspace, per-service Docker builds |
| [custom-iam-roles-ts](../deploy/samples/cdk/custom-iam-roles-ts/) | `pipeline-stack.ts` | IAM role configuration | Pipeline-level `role` (global), step-level `codebuildstep:role` and `codebuildstep:actionrole` via metadata |
| [secrets-management-ts](../deploy/samples/cdk/secrets-management-ts/) | `pipeline-stack.ts` | Secrets Manager integration | Global `orgId` for tenant-scoped secrets, plugin `secrets` declarations, SECRETS_MANAGER env var injection |

### IAM Role Levels

The [custom-iam-roles-ts](../deploy/samples/cdk/custom-iam-roles-ts/) example demonstrates three levels of IAM role control:

| Level | Configuration | Trust Principal | Purpose |
|-------|---------------|-----------------|---------|
| **Pipeline (global)** | `BuilderProps.role` | `codepipeline.amazonaws.com` | IAM role for the CodePipeline construct itself |
| **Step project role** | `aws:cdk:pipelines:codebuildstep:role` metadata | `codebuild.amazonaws.com` | IAM role for the CodeBuild project execution |
| **Step action role** | `aws:cdk:pipelines:codebuildstep:actionrole` metadata | — | IAM role for the CodePipeline action trigger |

### Secrets Resolution

The [secrets-management-ts](../deploy/samples/cdk/secrets-management-ts/) example demonstrates how secrets flow from AWS Secrets Manager into CodeBuild steps:

1. Set `orgId` on `BuilderProps` (global — enables resolution for all plugins)
2. Plugins declare `secrets: [{ name: 'SECRET_NAME', required: true }]` in their database record
3. At deployment, secrets resolve from `pipeline-builder/{orgId}/{secretName}` in AWS Secrets Manager
4. Secrets appear as `SECRETS_MANAGER`-type CodeBuild environment variables — no manual wiring needed

---

## Loading Samples

Use the provided script to load all pipeline samples into a running Platform instance:

```bash
cd deploy
./bin/load-pipelines.sh

# Or with a custom URL
PLATFORM_BASE_URL=https://my-platform.example.com ./bin/load-pipelines.sh
```

The script authenticates, then iterates over all `pipeline.json` files in `deploy/samples/pipelines/` and creates them via the Pipeline API.
