# Documentation

## Getting Started

1. **Deploy** — choose [Local](../deploy/local/), [Minikube](../deploy/minikube/), [EC2, or Fargate](aws-deployment.md)
2. **Register** — create an admin user and organization
3. **Load plugins** — upload from `deploy/plugins/` or create your own
4. **Build pipelines** — use the dashboard, CLI, API, or AI prompt

---

## Key Concepts

- **Pipeline** — CI/CD definition composed of stages, each referencing plugins. Synthesized into AWS CDK stacks at deploy time.
- **Plugin** — Reusable build step packaged as a Dockerfile + manifest. Runs as an isolated CodeBuild action inside CodePipeline.
- **Organization** — Multi-tenant isolation boundary. All resources are scoped to an org with RBAC access control.
- **Compliance Rule** — Configurable constraint that validates plugins and pipelines before creation. Supports 18 operators, computed fields, and cross-field checks.
- **Metadata Keys** — Typed configuration keys controlling CodePipeline and CodeBuild behavior (IAM, networking, compute). See [Metadata Keys](metadata-keys.md).
- **Secrets** — Plugin credentials stored in AWS Secrets Manager under `pipeline-builder/{orgId}/{secretName}`. Injected at build time, never stored in images.

---

## Guides

| Document | Description |
|----------|-------------|
| [API Reference](api-reference.md) | REST endpoints for pipelines, plugins, compliance, reporting, and AI generation |
| [Compliance](compliance.md) | Per-org rule engine with 18 operators, computed fields, audit trail |
| [Environment Variables](environment-variables.md) | Configuration reference for all services |
| [AWS Deployment](aws-deployment.md) | EC2 and Fargate deployment with post-deploy setup |
| [Metadata Keys](metadata-keys.md) | 56 CodePipeline/CodeBuild configuration keys |
| [Samples](samples.md) | Pipeline configs for 7 languages and CDK patterns |
| [Plugin Catalog](plugins/README.md) | 125 pre-built plugins across 10 categories |

---

## Setting Up Organizations

Organizations are the core isolation boundary. Every resource — pipelines, plugins, compliance rules, quotas, secrets, and billing — is scoped to an organization.

### Creating an Organization

Register an account, then create one or more organizations. The creator becomes the **owner**.

**From the dashboard** — navigate to **Team** and click **Create Organization**. Available to org admins, org owners, and system admins. Use the **org switcher** in the sidebar to switch between organizations.

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

Invite members via email from the dashboard or API. Invitees join with the role specified at invite time. A user can belong to multiple organizations and switch between them.

### Feature Tiers

AI generation and bulk operations are gated by the organization's subscription tier:

| Feature | Developer | Pro | Unlimited |
|---------|-----------|-----|-----------|
| Pipeline / plugin CRUD | yes | yes | yes |
| AI pipeline generation | - | yes | yes |
| AI plugin generation | - | yes | yes |
| Bulk operations | - | yes | yes |
| Audit log | - | - | yes |
| Custom integrations | - | - | yes |
| Priority support | - | yes | yes |

System org users always have access to all features. Per-user overrides can be set by admins to grant or revoke individual features regardless of tier.

### Example Team Structures

Different teams use separate organizations to maintain isolation while sharing the same platform:

| Organization | Team | Purpose |
|-------------|------|---------|
| `acme-platform` | Platform / DevOps | Approved base plugins, org-wide compliance rules, shared pipeline templates |
| `acme-backend` | Backend engineering | Java/Go service pipelines, internal plugins, team-specific quotas |
| `acme-frontend` | Frontend engineering | Node.js/React pipelines, Cypress testing plugins, deploy-to-CDN workflows |
| `acme-data` | Data engineering | Python/Spark pipelines, notebook linting, S3 artifact publishing |
| `acme-security` | Security | Strict compliance rules (required scans, no public plugins), audit trail review |

### What Each Org Controls

- **Plugins** — upload private plugins or use shared public ones; control which versions are available
- **Compliance rules** — enforce security standards, naming conventions, resource limits, and banned commands
- **Quotas** — set limits on pipelines, plugins, and API calls
- **Billing** — per-org subscription plans and usage tracking
- **Secrets** — stored in AWS Secrets Manager under `pipeline-builder/{orgId}/{secretName}`, injected at build time

---

## Creating Pipelines

Five ways to create a pipeline — pick the one that fits your workflow:

### Dashboard and AI

The web UI at `https://localhost:8443` provides visual pipeline and plugin management. The AI builder analyzes a Git repository and generates the right stages and plugins automatically.

### CLI

```bash
npm install -g @mwashburn160/pipeline-manager
export PLATFORM_TOKEN=<jwt-from-login>

# Upload a plugin
pipeline-manager upload-plugin --file ./node-build.zip --organization my-org --name node-build --version 1.0.0

# Create a pipeline
pipeline-manager create-pipeline --file ./pipeline-props.json --project my-app --organization my-org

# Deploy
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
        "source": {
          "type": "github",
          "options": { "repo": "my-org/my-app", "branch": "main" }
        },
        "plugin": { "name": "cdk-synth", "version": "1.0.0" }
      }
    }
  }'

# AI-generate a pipeline
curl -X POST https://localhost:8443/api/pipelines/generate \
  -H "Authorization: Bearer $TOKEN" -H "x-org-id: $ORG_ID" \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "Build a Node.js app from GitHub, run tests, and deploy with CDK",
    "provider": "anthropic",
    "model": "claude-sonnet-4-20250514"
  }'
```

See the [API Reference](api-reference.md) for the full endpoint list with query parameters and response formats.

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
    {
      stageName: 'Test',
      steps: [{ name: 'unit-tests', plugin: { name: 'jest', version: '1.0.0' } }],
    },
    {
      stageName: 'Deploy',
      steps: [{ name: 'deploy-prod', plugin: { name: 'cdk-deploy', version: '1.0.0' },
        env: { ENVIRONMENT: 'production' } }],
    },
  ],
});
```

See the [Samples](samples.md) page for CDK examples including VPC-isolated builds, cross-account deployments, monorepo pipelines, and custom IAM role configurations.

---

## Start / Stop

### Local (Docker Compose)

```bash
# Start
cd deploy/local && ./bin/startup.sh

# Stop
cd deploy/local && docker compose down

# Stop and remove volumes
cd deploy/local && docker compose down -v
```

### Minikube (local Kubernetes)

```bash
# Start
bash deploy/minikube/bin/startup.sh

# Stop (deletes cluster + port-forwards)
bash deploy/minikube/bin/shutdown.sh

# Check pods
kubectl get pods -n pipeline-builder
```

### AWS EC2 (SSH into instance first)

```bash
# Start (after reboot or shutdown)
sudo bash /opt/pipeline-builder/deploy/aws/ec2/bin/startup.sh

# Stop
sudo bash /opt/pipeline-builder/deploy/aws/ec2/bin/shutdown.sh

# Check pods
sudo -u minikube kubectl get pods -n pipeline-builder
```

### AWS Fargate

```bash
cd deploy/aws/fargate

# Deploy all stacks
bash bin/deploy.sh --stack-prefix pb --region us-east-1 --domain app.example.com

# Teardown all stacks
bash bin/teardown.sh --stack-prefix pb --region us-east-1
```

See the [AWS Deployment](aws-deployment.md) guide for full deployment instructions, parameters, post-deploy steps, and troubleshooting.

---

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

---

## Plugin Categories

125 plugins ship across 10 categories. See the [Plugin Catalog](plugins/README.md) for the full list with secrets reference and version management details.

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
