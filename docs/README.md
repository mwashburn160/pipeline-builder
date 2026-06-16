---
layout: default
title: Documentation
permalink: /docs/
---

# Documentation

Setup, usage, and reference for Pipeline Builder. New here? Start with [Getting Started](#getting-started) below, then jump into [Creating Pipelines](#creating-pipelines).

## Getting Started

1. **Deploy** — choose [Local](../deploy/local/), [Minikube](../deploy/minikube/), [EC2, or Fargate](aws-deployment.md)
2. **Register** — create an admin user and organization
3. **Load plugins** — upload from `deploy/plugins/` or create your own
4. **Build pipelines** — use the dashboard, CLI, API, or AI prompt

---

## Key Concepts

- **Pipeline** — CI/CD definition composed of stages, each referencing plugins. Synthesized into AWS CDK stacks at deploy time.
- **Plugin** — Reusable build step packaged as a Dockerfile + plugin-spec.yaml. Runs as an isolated CodeBuild action inside CodePipeline. Supports `build_image` (build at upload) or `prebuilt` (pre-built image.tar bundled in zip).
- **Organization** — the isolation boundary. All resources (pipelines, plugins, rules, quotas, secrets, billing) are scoped to an org with RBAC access control.
- **Team** — an organization optionally nested one level under a parent org (the org → team hierarchy). Opt-in: every org is a flat root by default. A team has its own members, quotas, and secrets, but its parent-org admins can manage it and visibility/quotas/compliance/analytics roll across the parent ↔ team relationship.
- **Compliance Rule** — Configurable constraint that validates plugins and pipelines before creation. Supports 18 operators, computed fields, and cross-field checks.
- **Metadata Keys** — Typed configuration keys controlling CodePipeline and CodeBuild behavior (IAM, networking, compute). See [Metadata Keys](metadata-keys.md).
- **Secrets** — Plugin credentials stored in AWS Secrets Manager under `pipeline-builder/{orgId}/{secretName}`. Injected at build time, never stored in images.

---

## Guides

### How-To

| Document | Description |
|----------|-------------|
| [AWS Deployment](aws-deployment.md) | EC2 and Fargate deployment, post-deploy setup, drift detection |
| [CDK Usage](cdk-usage.md) | `PipelineBuilder` construct, sources, stages, VPC, IAM, secrets |
| [Compliance](compliance.md) | Per-org rule engine with 18 operators, computed fields, audit trail |
| [Audit Events](audit-events.md) | Cross-service audit event names + payload schemas (registry, etc.) |
| [Environment Variables](environment-variables.md) | Configuration reference for all services |
| [Samples](samples.md) | Pipeline configs for 7 languages and CDK patterns |

### Reference

| Document | Description |
|----------|-------------|
| [API Reference](api-reference.md) | REST endpoints for pipelines, plugins, compliance, reporting, AI |
| [Metadata Keys](metadata-keys.md) | 80 typed CodePipeline, CodeBuild, networking, and IAM configuration keys |
| [Template Syntax](templates.md) | `{{ ... }}` interpolation for pipeline configs and plugin specs |
| [Plugin Catalog](plugins/README.md) | 125 pre-built plugins across 10 categories |
| [Org → Team Hierarchy](#teams-org--team-hierarchy) | Sub-organizations (teams) nested one level under a parent org — RBAC, visibility, quota, and compliance inheritance |

---

## Creating Pipelines

### Dashboard and AI

The web UI at `https://localhost:8443` provides visual pipeline and plugin management. The AI builder analyzes a Git repository (or a natural-language prompt) and generates the right stages and plugins automatically, streaming results over SSE. It works across five providers — Anthropic, OpenAI, Google, xAI, and Amazon Bedrock — and can fall back to a secondary provider if the primary one is unavailable.

**Default credentials** (created by `init-platform.sh local` on a fresh install):

| Field | Value |
|---|---|
| Identifier | `admin@internal` |
| Password | `SecurePassword123!` |

`init-platform.sh` is non-interactive: it reads `PLATFORM_IDENTIFIER` and `PLATFORM_PASSWORD` from the environment and falls back to the defaults above when unset — on **every** target. **On any non-local or production target, export real `PLATFORM_IDENTIFIER` / `PLATFORM_PASSWORD` before running** — otherwise the admin is created with this trivial dev password. Change the password from the dashboard immediately after first login on anything reachable beyond your laptop.

### CLI

```bash
npm install -g @pipeline-builder/pipeline-manager
export PLATFORM_TOKEN=<jwt-from-login>

pipeline-manager upload-plugin --file ./node-build.zip --organization my-org --name node-build --version 1.0.0
pipeline-manager create-pipeline --file ./pipeline-props.json --project my-app --organization my-org
pipeline-manager deploy --id <pipeline-id> --profile production
```

### REST API

```bash
# Create a pipeline
curl -X POST https://localhost:8443/api/pipelines \
  -H "Authorization: Bearer $TOKEN" -H "x-org-id: $ORG_ID" \
  -H "Content-Type: application/json" \
  -d '{
    "project": "my-app",
    "organization": "my-org",
    "pipelineName": "my-app-pipeline",
    "accessModifier": "private",
    "props": {
      "project": "my-app",
      "organization": "my-org",
      "synth": {
        "source": { "type": "github", "options": { "repo": "my-org/my-app", "branch": "main" } },
        "plugin": { "name": "cdk-synth", "version": "1.0.0" }
      }
    }
  }'

# AI-generate a pipeline
curl -X POST https://localhost:8443/api/pipelines/generate \
  -H "Authorization: Bearer $TOKEN" -H "x-org-id: $ORG_ID" \
  -H "Content-Type: application/json" \
  -d '{"prompt": "Build a Node.js app from GitHub, run tests, and deploy with CDK", "provider": "anthropic", "model": "claude-sonnet-4-20250514"}'
```

See the [API Reference](api-reference.md) for the full endpoint list.

### CDK Construct

```typescript
import { App, Stack } from 'aws-cdk-lib';
import { PipelineBuilder } from '@mwashburn160/pipeline-core';

const app = new App();
const stack = new Stack(app, 'MyPipelineStack', {
  env: { account: '123456789012', region: 'us-east-1' },
});

new PipelineBuilder(stack, 'MyPipeline', {
  project: 'my-app',
  organization: 'my-org',
  synth: {
    source: {
      type: 'github',
      options: { repo: 'my-org/my-app', branch: 'main',
        connectionArn: 'arn:aws:codestar-connections:us-east-1:...:connection/...' },
    },
    plugin: { name: 'cdk-synth', version: '1.0.0' },
  },
  stages: [
    { stageName: 'Test', steps: [{ name: 'unit-tests', plugin: { name: 'jest', version: '1.0.0' } }] },
    { stageName: 'Deploy', steps: [{ name: 'deploy-prod', plugin: { name: 'cdk-deploy', version: '1.0.0' }, env: { ENVIRONMENT: 'production' } }] },
  ],
});
```

See [Samples](samples.md) for more CDK patterns.

---

## Start / Stop

### Local (Docker Compose)

```bash
cd deploy/local && ./bin/setup.sh        # Start
cd deploy/local && docker compose down     # Stop
cd deploy/local && docker compose down -v  # Stop + remove volumes
```

### Minikube

```bash
bash deploy/minikube/bin/setup.sh        # Start
bash deploy/minikube/bin/shutdown.sh       # Stop
kubectl get pods -n pipeline-builder       # Check
```

### AWS EC2

```bash
sudo bash /opt/pipeline/pipeline-builder/deploy/aws/ec2/bin/startup.sh    # Start
sudo bash /opt/pipeline/pipeline-builder/deploy/aws/ec2/bin/shutdown.sh   # Stop
sudo -u minikube kubectl get pods -n pipeline-builder             # Check
```

### AWS Fargate

```bash
cd deploy/aws/fargate
bash bin/setup.sh --stack-prefix pb --region us-east-1 --domain app.example.com  # Deploy
bash bin/teardown.sh --stack-prefix pb --region us-east-1                          # Teardown
```

See [AWS Deployment](aws-deployment.md) for full instructions and post-deploy setup.

### Post-Deploy: Initialize Platform

`init-platform.sh` registers the admin user and loads plugins. **On EC2/Fargate it runs automatically by default** (auto-init — EC2 on first boot, Fargate via the one-shot `07-init` ECS task); you only run it by hand on **local/minikube**, or on EC2/Fargate when you deployed with `--no-auto-init`:

```bash
# Local / Minikube — interactive
./deploy/bin/init-platform.sh local
./deploy/bin/init-platform.sh minikube

# EC2 (only if --no-auto-init) — requires the minikube user context, on the box
sudo -u minikube PLATFORM_BASE_URL=https://your-ip bash /opt/pipeline/pipeline-builder/deploy/bin/init-platform.sh ec2

# Non-interactive with prebuilt images and controlled parallelism
PLUGIN_BUILD_STRATEGY=prebuilt PARALLEL_JOBS=2 ./deploy/bin/init-platform.sh local
```

Key env vars: `PLUGIN_BUILD_STRATEGY` (`build_image`/`prebuilt`), `PLUGIN_CATEGORY` (comma-separated filter), `PARALLEL_JOBS` (upload concurrency, auto-lowered to 1 for prebuilt), `FORCE_REBUILD` (rebuild existing image.tar files).

**Admin credentials** — `init-platform.sh` is non-interactive and reads them from the environment, falling back to defaults when unset:

| Env var | Default (used if unset) |
|---|---|
| `PLATFORM_IDENTIFIER` | `admin@internal` |
| `PLATFORM_PASSWORD` | `SecurePassword123!` |

The defaults apply on **every** target, so **export real values on `minikube`/`ec2`/`fargate`** (or any shared/production environment) before running — otherwise the admin is created with the trivial dev password.

---

## Organizations

Organizations are the isolation boundary — each one is a self-contained workspace. Every resource — pipelines, plugins, compliance rules, quotas, secrets, and billing — is scoped to an organization. Organizations can optionally nest **teams** (see [Teams](#teams-org--team-hierarchy) below). This section covers admin tasks; new evaluators can skip ahead to [Architecture](#architecture).

### Creating an Organization

Register an account, then create one or more organizations. The creator becomes the **owner**.

**From the dashboard** — navigate to **Team** and click **Create Organization**.

**From the API:**

```bash
curl -X POST https://localhost:8443/api/organization \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"acme-platform","displayName":"Acme Platform Team"}'
```

### Roles

| Role | Capabilities |
|------|-------------|
| **Owner** | Full control — manage members, transfer ownership, delete org |
| **Admin** | Manage plugins, pipelines, compliance rules, quotas, and invite members |
| **Member** | Create and manage their own pipelines and plugins |

Invite members via email from the dashboard or API. A user can belong to multiple organizations.

### Teams (Org → Team Hierarchy)

A **team** is an organization nested one level under a parent (root) organization. Nesting is **opt-in** — every organization is a flat root until you create a team under it, and teams can't have their own sub-teams (the hierarchy is one level deep). A team is a full organization: it has its own members, roles, quotas, secrets, and billing.

What the parent ↔ team relationship adds on top of plain organizations:

- **Effective RBAC** — a parent-org **admin/owner** can administer its teams (manage members, rules, quotas) without a separate membership; team-local roles still apply within the team.
- **Inherited plugin visibility** — a team sees its parent's private plugins in addition to its own and the public catalog.
- **Compliance propagation** — a parent rule marked *apply to child teams* is enforced on its teams.
- **Shared quota cap** — a parent's limit can be shared across the subtree (the root cap is checked before each team's own atomic increment).
- **Rolled-up analytics** — a parent admin can include child-team data in execution reports.

A user can belong to several organizations and teams at once and acts within one at a time (switch with the org switcher).

**Creating / managing teams** — on the dashboard **Members** page, an admin of a root org uses **Create Sub-Org / Team** to nest a new team and **Manage teams** (per member) to add or remove a member across the org's teams in one step. Via the API, `POST /api/organization` accepts a `parentOrgId`, and `POST /api/organization/:id/members/bulk-add` adds a user to several teams at once.

### Feature Tiers

| Feature | Developer | Pro | Unlimited |
|---------|-----------|-----|-----------|
| Pipeline / plugin CRUD | yes | yes | yes |
| AI pipeline generation | - | yes | yes |
| AI plugin generation | - | yes | yes |
| Bulk operations | - | yes | yes |
| Audit log | - | - | yes |
| Custom integrations | - | - | yes |
| Priority support | - | yes | yes |

System org users always have access to all features.

### What Each Org Controls

- **Plugins** — upload private plugins or use shared public ones; control which versions are available
- **Compliance rules** — enforce security standards, naming conventions, resource limits
- **Quotas** — set limits on pipelines, plugins, and API calls
- **Billing** — per-org subscription plans and usage tracking
- **Secrets** — stored in AWS Secrets Manager, injected at build time

---

## Architecture

```mermaid
flowchart TB
    UI[Dashboard / CLI] --> NGINX[Nginx<br/>TLS + Routing]
    NGINX --> PIPE[Pipeline Service]
    NGINX --> PLUG[Plugin Service]
    NGINX --> PLAT[Platform Service]
    PIPE --> COMP[Compliance]
    PLUG --> REP[Reporting]
    PLAT --> QB[Quota / Billing]
    COMP & REP & QB --> DB[(PostgreSQL / MongoDB / Redis)]
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

For end-to-end request → build → deploy flow diagrams, see [Architecture Flow](architecture-flow.md). For the case for adopting Pipeline Builder org-wide, see [Organization Benefits](organization-benefits.md).

---

## Plugin Categories

125 plugins across 10 categories. See the [Plugin Catalog](plugins/README.md) for the full list.

| Category | Count | Details |
|----------|-------|---------|
| [Language](plugins/language.md) | 11 | Java, Python, Node.js, Go, Rust, .NET |
| [Security](plugins/security.md) | 40 | Snyk, SonarCloud, Trivy, Veracode, Semgrep |
| [Quality](plugins/quality.md) | 17 | ESLint, Prettier, Checkstyle, Clippy, Ruff |
| [Testing](plugins/testing.md) | 14 | Jest, Pytest, Cypress, Playwright, k6 |
| [Artifact](plugins/artifact.md) | 16 | Docker, ECR, GHCR, npm, PyPI, Maven |
| [Deploy](plugins/deploy.md) | 13 | Terraform, CloudFormation, Kubernetes, Helm, CDK |
| [Infrastructure](plugins/infrastructure.md) | 5 | CDK synth, manual approval, S3 cache, shell |
| [Monitoring](plugins/monitoring.md) | 3 | Datadog, New Relic, Sentry |
| [Notification](plugins/notification.md) | 5 | Slack, Teams, PagerDuty, email |
| [AI](plugins/ai.md) | 1 | Dockerfile generation (multi-provider) |

---

## Next Steps

- **First time?** Deploy [Local](../deploy/local/) and walk through [Creating Pipelines](#creating-pipelines).
- **Setting up for your team?** Read [Organization Benefits](organization-benefits.md), then [Organizations](#organizations) above.
- **Wiring CI from code?** [CDK Usage](cdk-usage.md) → [Samples](samples.md) → [Template Syntax](templates.md).
- **Going to production on AWS?** [AWS Deployment](aws-deployment.md) covers EC2, Fargate, drift detection, and event reporting.
