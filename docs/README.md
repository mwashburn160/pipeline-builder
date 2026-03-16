# Pipeline Builder Documentation

Pipeline Builder is a platform for creating, managing, and deploying AWS CodePipeline CI/CD pipelines using a plugin-based architecture. Define your pipeline stages with reusable plugins, and Pipeline Builder synthesizes them into fully functional AWS CDK stacks.

---

## Getting Started

1. **Deploy the platform** -- choose [EC2 or Fargate](aws-deployment.md)
2. **Initialize** -- register an admin user and load plugins ([post-deploy steps](aws-deployment.md#post-deploy-steps))
3. **Configure** -- set [environment variables](environment-variables.md) for your services
4. **Build pipelines** -- use the [API](api-reference.md) or the web UI to create pipelines from plugins

---

## Documentation

| Document | Description |
|----------|-------------|
| [Environment Variables](environment-variables.md) | All configurable environment variables across services, databases, quotas, billing, and more |
| [API Reference](api-reference.md) | REST API endpoints for pipelines, plugins, reports, and AI generation with curl examples |
| [AWS Deployment](aws-deployment.md) | Step-by-step deployment guides for EC2 (Minikube) and Fargate (ECS), including post-deploy setup and reporting |
| [Plugin Catalog](plugins/README.md) | 125 pre-built plugins across 10 categories, plugin structure, secrets management, and version management |
| [Metadata Keys](metadata-keys.md) | CDK metadata keys for configuring CodePipeline and CodeBuild resources (IAM roles, networking, compute) |
| [Samples](samples.md) | Ready-to-use pipeline configurations for 7 languages, plus advanced CDK patterns (VPC, cross-account, multi-region) |

---

## Architecture Overview

```
                         +-------------------+
                         |    Frontend (UI)   |
                         +---------+---------+
                                   |
                              +----+----+
                              |  Nginx  |  (TLS, routing, JWT)
                              +----+----+
                                   |
              +--------------------+--------------------+
              |                    |                     |
     +--------+--------+  +-------+--------+  +--------+--------+
     | Pipeline Service |  | Plugin Service |  | Platform Service|
     +--------+--------+  +-------+--------+  +--------+--------+
              |                    |                     |
              +--------------------+--------------------+
              |                    |                     |
     +--------+--------+  +-------+--------+  +--------+--------+
     |   PostgreSQL     |  |    MongoDB     |  |     Redis       |
     +-----------------+  +----------------+  +-----------------+

     +-----------------------------------------------------------+
     | Observability: Prometheus, Loki, Grafana                   |
     +-----------------------------------------------------------+
```

**Services:**
- **Pipeline Service** -- CRUD for pipeline definitions; synthesizes CDK stacks from plugin references
- **Plugin Service** -- CRUD for plugins; handles Docker image builds via BullMQ job queue
- **Platform Service** -- Authentication, user management, organization management
- **Quota Service** -- Rate limiting and resource quotas per organization
- **Billing Service** -- Subscription and usage billing
- **Reporting Service** -- Pipeline execution analytics via EventBridge ingestion

---

## Plugin Categories

Pipeline Builder ships with 125 plugins across 10 categories. See the [Plugin Catalog](plugins/README.md) for full details.

| Category | Count | Examples |
|----------|-------|---------|
| [Language](plugins/language.md) | 11 | Java, Python, Node.js, Go, Rust, .NET, Ruby, C++, PHP |
| [Security](plugins/security.md) | 40 | Snyk, SonarCloud, Trivy, Veracode, Checkmarx, Semgrep |
| [Quality](plugins/quality.md) | 17 | ESLint, Prettier, Checkstyle, Clippy, RuboCop, Ruff |
| [Testing](plugins/testing.md) | 14 | Jest, Pytest, Cypress, Playwright, k6, Postman |
| [Artifact](plugins/artifact.md) | 16 | Docker build, ECR/GHCR/GAR push, npm/PyPI/Maven publish |
| [Deploy](plugins/deploy.md) | 11 | Terraform, CloudFormation, Kubernetes, Helm, Pulumi |
| [Infrastructure](plugins/infrastructure.md) | 5 | CDK synth/deploy, manual approval, S3 cache |
| [Monitoring](plugins/monitoring.md) | 3 | Datadog, New Relic, Sentry |
| [Notification](plugins/notification.md) | 5 | Slack, Teams, PagerDuty, email, GitHub status |
| [AI](plugins/ai.md) | 2 | Dockerfile generation (local Ollama + cloud providers) |

---

## Key Concepts

- **Pipeline** -- A CI/CD pipeline definition composed of stages, each referencing one or more plugins. Stored as JSON and synthesized into an AWS CDK stack at deploy time.
- **Plugin** -- A reusable build step packaged as a Dockerfile + manifest. Each plugin runs as an isolated CodeBuild action inside CodePipeline.
- **Organization** -- Multi-tenant isolation boundary. All resources (pipelines, plugins, quotas, secrets) are scoped to an organization.
- **Metadata Keys** -- Typed configuration keys that control CodePipeline and CodeBuild behavior (IAM roles, networking, compute size). See [Metadata Keys](metadata-keys.md).
- **Secrets** -- Plugin credentials stored in AWS Secrets Manager under `pipeline-builder/{orgId}/{secretName}`. Injected at build time, never stored in images.
