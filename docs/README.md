# Documentation

## Getting Started

1. **Deploy** — choose [Local](../deploy/local/), [Minikube](../deploy/minikube/), [EC2, or Fargate](aws-deployment.md)
2. **Register** — create an admin user and organization
3. **Load plugins** — upload from `deploy/plugins/` or create your own
4. **Build pipelines** — use the dashboard, CLI, API, or AI prompt

## Guides

| Document | Description |
|----------|-------------|
| [API Reference](api-reference.md) | REST endpoints for pipelines, plugins, compliance, reporting, and AI generation |
| [Compliance](compliance.md) | Per-org rule engine with 18 operators, computed fields, audit trail |
| [Environment Variables](environment-variables.md) | Configuration reference for all services |
| [AWS Deployment](aws-deployment.md) | EC2 and Fargate deployment with post-deploy setup |
| [Metadata Keys](metadata-keys.md) | 50+ CodePipeline/CodeBuild configuration keys |
| [Samples](samples.md) | Pipeline configs for 7 languages and CDK patterns |
| [Plugin Catalog](plugins/README.md) | 125 pre-built plugins across 10 categories |

## Architecture

```
                    ┌─────────────────────┐
                    │   Dashboard / CLI    │
                    └──────────┬──────────┘
                               │
                         ┌─────┴─────┐
                         │   Nginx   │  TLS, routing, JWT
                         └─────┬─────┘
                               │
          ┌────────────────────┼────────────────────┐
          │                    │                     │
   ┌──────┴──────┐     ┌──────┴──────┐     ┌───────┴───────┐
   │  Pipeline   │     │   Plugin    │     │   Platform    │
   │  Service    │     │   Service   │     │   Service     │
   └──────┬──────┘     └──────┬──────┘     └───────┬───────┘
          │                   │                     │
          ├───────────────────┤                     │
          │                   │                     │
   ┌──────┴──────┐     ┌─────┴──────┐     ┌───────┴───────┐
   │ Compliance  │     │  Reporting │     │ Quota/Billing │
   └─────────────┘     └────────────┘     └───────────────┘
          │                   │                     │
   ┌──────┴───────────────────┴─────────────────────┴──────┐
   │         PostgreSQL  ·  MongoDB  ·  Redis              │
   └───────────────────────────────────────────────────────┘
```

| Service | Purpose |
|---------|---------|
| **Platform** | Auth, orgs, users, JWT, RBAC |
| **Pipeline** | Pipeline CRUD, AI generation, CDK synthesis |
| **Plugin** | Plugin CRUD, Docker image builds, AI generation |
| **Compliance** | Per-org rule enforcement, policy management, audit trail |
| **Reporting** | Execution analytics via EventBridge ingestion |
| **Quota** | Resource limits per organization |
| **Billing** | Subscriptions and usage billing |
| **Message** | Org announcements and conversations |

## Key Concepts

- **Pipeline** — CI/CD definition composed of stages, each referencing plugins. Synthesized into AWS CDK stacks at deploy time.
- **Plugin** — Reusable build step packaged as a Dockerfile + manifest. Runs as an isolated CodeBuild action inside CodePipeline.
- **Organization** — Multi-tenant isolation boundary. All resources are scoped to an org with RBAC access control.
- **Compliance Rule** — Configurable constraint that validates plugins and pipelines before creation. Supports 18 operators, computed fields, and cross-field checks.
- **Metadata Keys** — Typed configuration keys controlling CodePipeline and CodeBuild behavior (IAM, networking, compute). See [Metadata Keys](metadata-keys.md).
- **Secrets** — Plugin credentials stored in AWS Secrets Manager under `pipeline-builder/{orgId}/{secretName}`. Injected at build time, never stored in images.

## Plugin Categories

125 plugins ship across 10 categories. See the [Plugin Catalog](plugins/README.md).

| Category | Count | Examples |
|----------|-------|---------|
| [Language](plugins/language.md) | 11 | Java, Python, Node.js, Go, Rust, .NET |
| [Security](plugins/security.md) | 40 | Snyk, SonarCloud, Trivy, Veracode, Semgrep |
| [Quality](plugins/quality.md) | 17 | ESLint, Prettier, Checkstyle, Clippy, Ruff |
| [Testing](plugins/testing.md) | 14 | Jest, Pytest, Cypress, Playwright, k6 |
| [Artifact](plugins/artifact.md) | 16 | Docker, ECR, GHCR, npm, PyPI, Maven |
| [Deploy](plugins/deploy.md) | 11 | Terraform, CloudFormation, Kubernetes, Helm |
| [Infrastructure](plugins/infrastructure.md) | 5 | CDK synth/deploy, manual approval, S3 cache |
| [Monitoring](plugins/monitoring.md) | 3 | Datadog, New Relic, Sentry |
| [Notification](plugins/notification.md) | 5 | Slack, Teams, PagerDuty, email |
| [AI](plugins/ai.md) | 2 | Dockerfile generation (local + cloud) |
