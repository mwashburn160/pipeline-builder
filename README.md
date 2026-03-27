<p align="center">
  <strong>Pipeline Builder</strong><br/>
  <em>Production-ready AWS CodePipelines from TypeScript, CLI, or a single AI prompt.</em>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-Apache%202.0-blue.svg" alt="License"></a>
  <img src="https://img.shields.io/badge/TypeScript-5.9-blue?logo=typescript&logoColor=white" alt="TypeScript">
  <img src="https://img.shields.io/badge/AWS%20CDK-2.240-orange?logo=amazonaws&logoColor=white" alt="AWS CDK">
  <img src="https://img.shields.io/badge/Node.js-%E2%89%A524.9-brightgreen?logo=nodedotjs&logoColor=white" alt="Node.js">
  <img src="https://img.shields.io/badge/Next.js-16-black?logo=nextdotjs&logoColor=white" alt="Next.js">
</p>

---

Pipeline Builder turns plugin definitions and pipeline configs into fully deployed AWS CodePipeline infrastructure — inside the client's AWS account with zero lock-in.

## Why Pipeline Builder

**For engineering organizations** that need standardized, repeatable CI/CD without the overhead of maintaining bespoke pipeline definitions per team:

- **Self-service pipeline creation** — developers create pipelines through a dashboard, CLI, API, or AI prompt without needing AWS expertise
- **Organizational governance** — per-org compliance rules enforce security standards, naming conventions, and resource limits before anything gets deployed
- **Reusable plugin ecosystem** — 125 pre-built plugins cover builds, tests, security scans, deploys, and monitoring; teams share and version plugins across projects
- **Multi-tenant isolation** — every resource (pipelines, plugins, quotas, secrets) is scoped to an organization with RBAC access control
- **No vendor lock-in** — pipelines deploy as native AWS CodePipeline + CodeBuild resources in the client's own account; removing Pipeline Builder leaves working infrastructure
- **Cost visibility** — per-org quotas, billing integration, and execution analytics give leadership insight into CI/CD spend and usage patterns

## Use Cases

| Who | How they use it |
|-----|-----------------|
| **Platform team** | Defines approved plugins, sets compliance rules, manages org quotas — gives developers guardrails without bottlenecking them |
| **Application developer** | Pastes a Git URL, gets a working pipeline in minutes — AI analyzes the repo and generates the right stages and plugins |
| **DevOps engineer** | Uses CDK constructs or the CLI to define pipelines as code, version-controlled alongside application repos |
| **Security team** | Creates compliance rules that block non-compliant plugins (no public access, required secrets, banned commands) with full audit trail |
| **Engineering manager** | Uses reporting dashboards to track deployment frequency, failure rates, and build times across teams |

## Quick Start

```bash
git clone <repo-url> pipeline-builder && cd pipeline-builder
pnpm install && pnpm build

# Launch full local stack (frontend, APIs, databases, observability)
cd deploy/local && chmod +x bin/startup.sh && ./bin/startup.sh
```

Open **https://localhost:8443** — register, create an org, and start building pipelines.

> **Prerequisites:** Node.js >= 24.9, pnpm >= 10.25, Docker

---

## Organizations

Organizations are the core isolation boundary. Every resource — pipelines, plugins, compliance rules, quotas, secrets, and billing — is scoped to an organization.

### Creating an Organization

Register an account, then create one or more organizations from the dashboard or API. The creator becomes the **owner**.

```bash
# Register
curl -X POST https://localhost:8443/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","email":"admin@example.com","password":"..."}'

# Create an organization
curl -X POST https://localhost:8443/api/organization \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"acme-platform","displayName":"Acme Platform Team"}'
```

### Roles

| Role | Capabilities |
|------|-------------|
| **Owner** | Full control — manage members, transfer ownership, delete org |
| **Admin** | Manage plugins, pipelines, compliance rules, quotas, and invite members |
| **Member** | Create and manage their own pipelines and plugins |

Invite members via email from the dashboard or API. Invitees join with the role specified at invite time.

### Team Structures

Different teams use separate organizations to maintain isolation while sharing the same platform:

| Organization | Team | Purpose |
|-------------|------|---------|
| `acme-platform` | Platform / DevOps | Approved base plugins, org-wide compliance rules, shared pipeline templates |
| `acme-backend` | Backend engineering | Java/Go service pipelines, internal plugins, team-specific quotas |
| `acme-frontend` | Frontend engineering | Node.js/React pipelines, Cypress testing plugins, deploy-to-CDN workflows |
| `acme-data` | Data engineering | Python/Spark pipelines, notebook linting, S3 artifact publishing |
| `acme-security` | Security | Strict compliance rules (required scans, no public plugins), audit trail review |

### Org-Level Controls

Each organization independently configures:

- **Plugins** — upload private plugins or use shared public ones; control which versions are available
- **Compliance rules** — enforce security standards, naming conventions, resource limits, and banned commands
- **Quotas** — set limits on pipelines, plugins, and API calls per org
- **Billing** — per-org subscription plans and usage tracking
- **Secrets** — stored in AWS Secrets Manager under `pipeline-builder/{orgId}/{secretName}`, injected at build time

A user can belong to multiple organizations and switch between them. Each org sees only its own resources.

---

## Five Ways to Create a Pipeline

| Method | Example |
|--------|---------|
| **CDK Construct** | `new PipelineBuilder(stack, 'P', { ... })` |
| **CLI** | `pipeline-manager create-pipeline --file props.json` |
| **REST API** | `POST /api/pipelines` |
| **Dashboard** | Point, click, deploy |
| **AI Prompt** | *"Build and deploy a Next.js app from GitHub"* |

---

## Architecture

```mermaid
flowchart TB
    subgraph Interfaces
        CLI["CLI"] & DASH["Dashboard"] & API["REST API"] & CDK["CDK Constructs"]
    end

    subgraph Platform["Platform Service"]
        AUTH["Auth + JWT + Orgs + RBAC"]
    end

    subgraph Backend["Backend Services"]
        PLUGIN["Plugin"] & PIPELINE["Pipeline"]
        COMPLIANCE["Compliance"]
        REPORTING["Reporting"]
        SUPPORT["Quota + Billing + Messages"]
    end

    CORE["pipeline-core<br/>CDK Synth"]
    AWS["Client AWS Account"]

    CLI & DASH & API -->|JWT| Platform
    CDK --> CORE
    Platform --> PLUGIN & PIPELINE & COMPLIANCE & REPORTING & SUPPORT
    PLUGIN & PIPELINE -->|validate| COMPLIANCE
    PLUGIN & PIPELINE --> CORE
    CORE --> AWS
    AWS -->|EventBridge| REPORTING

    style Platform fill:#4A90D9,color:#fff
    style CORE fill:#F5A623,color:#fff
    style AWS fill:#2ECC71,color:#fff
    style COMPLIANCE fill:#E74C3C,color:#fff
    style REPORTING fill:#9B59B6,color:#fff
```

| Service | Purpose |
|---------|---------|
| **Platform** | Auth, orgs, users, JWT, RBAC — central gateway |
| **Pipeline** | Pipeline CRUD + AI generation |
| **Plugin** | Plugin CRUD + Docker builds + AI generation |
| **Compliance** | Per-org rule enforcement, policy management, audit trail |
| **Reporting** | Execution reports + build analytics |
| **Quota** | Resource limits per org |
| **Billing** | Subscriptions and plans |
| **Message** | Org announcements and messaging |

---

## CDK Construct

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

---

## CLI

```bash
npm install -g @mwashburn160/pipeline-manager
export PLATFORM_TOKEN=<jwt-from-login>

pipeline-manager upload-plugin --file ./node-build.zip --organization my-org --name node-build --version 1.0.0
pipeline-manager create-pipeline --file ./pipeline-props.json --project my-app --organization my-org
pipeline-manager deploy --id <pipeline-id> --profile production
```

Full command reference: [API Reference](docs/api-reference.md)

---

## AI Providers

| Provider | Models |
|----------|--------|
| Ollama (local) | Llama 3, Code Llama, Mistral, DeepSeek, Qwen |
| Anthropic | Claude Sonnet 4, Claude Haiku 4.5 |
| OpenAI | GPT-4o, GPT-4o Mini |
| Google | Gemini 2.0 Flash, Gemini 2.5 Pro |
| xAI | Grok 3, Grok 3 Fast, Grok 3 Mini |
| Amazon Bedrock | Claude 3.5 Sonnet, Nova Pro, Nova Lite |

Ollama runs locally with no API key. Cloud providers available when API keys are configured.

---

## Deployment

| Target | Best for | Cost |
|--------|----------|------|
| **[Local](deploy/local/)** | Development | Free |
| **[Minikube](deploy/minikube/)** | Local Kubernetes | Free |
| **[EC2](docs/aws-deployment.md#ec2)** | Dev/staging | ~$30-80/mo |
| **[Fargate](docs/aws-deployment.md#fargate)** | Production | ~$100-300/mo |

---

## Documentation

| Document | Description |
|----------|-------------|
| [API Reference](docs/api-reference.md) | REST endpoints, query params, curl examples |
| [Compliance](docs/compliance.md) | Rule engine, validation, audit trail |
| [Environment Variables](docs/environment-variables.md) | Full config reference for all services |
| [AWS Deployment](docs/aws-deployment.md) | EC2 and Fargate deployment guides |
| [Metadata Keys](docs/metadata-keys.md) | 50+ CodePipeline/CodeBuild configuration keys |
| [Samples](docs/samples.md) | Pipeline configs and CDK examples for 7 languages |
| [Plugin Catalog](docs/plugins/README.md) | 125 pre-built plugins across 10 categories |

---

## License

Apache License 2.0 — see [LICENSE](LICENSE).
