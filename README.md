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

## Highlights

| Challenge | How Pipeline Builder Solves It |
|-----------|-------------------------------|
| Developers need AWS expertise to set up CI/CD | Self-service pipeline creation via dashboard, CLI, API, or AI prompt |
| No governance over what gets deployed | Per-org compliance rules block non-compliant resources before deployment |
| Build steps are copy-pasted across teams | 124 reusable plugins shared and versioned across projects |
| Multi-team environments lack isolation | Every resource scoped to an organization with RBAC access control |
| Vendor lock-in with CI/CD platforms | Pipelines deploy as native AWS CodePipeline + CodeBuild in the client's own account |
| No visibility into CI/CD costs | Per-org quotas, billing integration, and execution analytics |

---

## Features

### Five Ways to Create Pipelines

| Interface | Description |
|-----------|-------------|
| **Dashboard** | Visual pipeline builder — point, click, deploy |
| **AI Prompt** | Paste a Git URL, get a complete pipeline generated from your repo |
| **CLI** | `pipeline-manager create-pipeline` for scripted workflows and CI integration |
| **REST API** | Full CRUD + AI generation endpoints for programmatic control |
| **CDK Construct** | `PipelineBuilder` construct for infrastructure-as-code |

### AI-Powered Generation

Analyzes a Git repository and generates stages and plugins automatically.

| Provider | Models |
|----------|--------|
| Anthropic | Claude Sonnet 4, Claude Haiku 4.5 |
| OpenAI | GPT-4o, GPT-4o Mini |
| Google | Gemini 2.0 Flash, Gemini 2.5 Pro |
| xAI | Grok 3, Grok 3 Fast, Grok 3 Mini |
| Amazon Bedrock | Claude 3.5 Sonnet, Nova Pro, Nova Lite |

### 124 Pre-Built Plugins

Reusable build steps covering the full CI/CD lifecycle. Every plugin runs as an isolated container step inside AWS CodePipeline.

| Category | Count | Examples |
|----------|-------|---------|
| Language | 11 | Java, Python, Node.js, Go, Rust, .NET, C++, PHP, Ruby |
| Security | 40 | Snyk, SonarCloud, Trivy, Veracode, Semgrep, Checkmarx, Fortify |
| Quality | 17 | ESLint, Prettier, Checkstyle, Clippy, Ruff, ShellCheck |
| Testing | 14 | Jest, Pytest, Cypress, Playwright, k6, Postman, Artillery |
| Artifact & Registry | 16 | Docker, ECR, GHCR, npm, PyPI, Maven, NuGet, Cargo |
| Deploy | 13 | Terraform, CloudFormation, Kubernetes, Helm, Pulumi, ECS, Lambda, CDK |
| Infrastructure | 4 | CDK synth, manual approval, S3 cache |
| Monitoring | 3 | Datadog, New Relic, Sentry |
| Notification | 5 | Slack, Teams, PagerDuty, email, GitHub status |
| AI | 1 | Dockerfile generation (multi-provider) |

### Synth-Time Scripting

{% raw %}
Pipeline configs and plugin specs both support a minimal `{{ path | filter }}` template syntax that's resolved once at synthesis time — no runtime evaluation, no code execution. Same template engine, two scopes:

**In `pipeline.json`** — self-references compose values from other metadata/vars:

```json
{
  "projectName": "{{ vars.service }}-{{ metadata.env }}",
  "metadata": {
    "env": "prod",
    "namespace": "{{ vars.service }}-{{ metadata.env }}",
    "clusterName": "acme-eks-{{ metadata.env }}"
  },
  "vars": { "service": "checkout" }
}
```

**In `plugin-spec.yaml`** — one plugin, many environments:

```yaml
name: kubectl-deploy
requiredMetadata: [namespace]
metadataTypes: { replicas: number }
env:
  KUBE_NAMESPACE: "{{ pipeline.metadata.namespace }}"
commands:
  - "kubectl apply -f k8s/{{ pipeline.metadata.env | default: 'staging' }}/"
  - "kubectl scale deployment {{ pipeline.projectName }} --replicas={{ pipeline.metadata.replicas | number }}"
```

**Capabilities:**
- **Path lookups** — `pipeline.*` (metadata, vars, projectName, orgId), `plugin.*`, `env.*` (own declared env vars)
- **`| default: '...'`** — fallback value when the path is undefined
- **Type coercion** — `| number`, `| bool`, `| json` for non-string fields
- **Plugin contracts** — `requiredMetadata` / `requiredVars` / `metadataTypes` declare what a plugin needs, validated at upload
- **Self-references with cycle detection** in pipeline configs
- **Preview & validate** — `pipeline-manager validate-templates`, `--show-resolved` flag, `?resolve=true` API param
- **Editor support** — frontend MetadataEditor parses tokens inline as you type

Fully backward-compatible: pipelines and plugins without `{{ ... }}` continue working unchanged. See [Template Syntax](docs/templates.md) for the full grammar, scope reference, and migration guide.
{% endraw %}

### Compliance Engine

Per-organization rule enforcement that validates plugins and pipelines before creation.

- 18 operators — equals, contains, regex, numeric comparison, array count, string length
- Computed fields, cross-field conditions, published rule catalog
- Severity levels — `warning` (non-blocking), `error` / `critical` (blocking)
- Bulk scans, audit trail, 10 sample rules included

### Multi-Tenant Organizations

Every resource — pipelines, plugins, compliance rules, quotas, secrets, billing — scoped to an organization with role-based access (Owner, Admin, Member), feature tiers (Developer, Pro, Unlimited), and per-org quotas across four dimensions: `plugins`, `pipelines`, `apiCalls`, and `aiCalls` (sized smaller per tier because AI calls have external $ cost).

### Execution Analytics

EventBridge captures CodePipeline and CodeBuild state changes. Reports include execution counts, success rates, duration percentiles, stage failure heatmaps, and error categorization.

### Service-to-Service Auth

Inter-service HTTP calls (billing → message renewals, compliance → message rule updates, platform → billing on org register, etc.) mint short-lived JWTs via `signServiceToken()` in api-core. Tokens identify the calling service via `sub: 'service:<name>'`, are signed with the shared `JWT_SECRET`, and satisfy the standard `requireAuth` middleware — so internal calls don't need per-route bypass.

### Operational Endpoints

Every service exposes:
- `GET /health` — liveness probe (returns 200 unless the process is dead)
- `GET /ready` — readiness probe (returns 503 when any dependency is `disconnected`)
- `GET /warmup` — pre-opens connection pools (Postgres + per-service hooks for Mongo/Redis)
- `GET /metrics` — Prometheus scrape endpoint

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
| **Pipeline** | Pipeline CRUD + AI generation + CDK synthesis |
| **Plugin** | Plugin CRUD + Docker image builds + AI generation |
| **Compliance** | Per-org rule enforcement, policy management, audit trail |
| **Reporting** | Execution reports + build analytics via EventBridge |
| **Quota** | Resource limits per org |
| **Billing** | Subscriptions and plans |
| **Message** | Org announcements and messaging |

For detailed end-to-end flows (plugin upload, pipeline creation, CDK synthesis, CodePipeline execution), see [Architecture Flow](docs/architecture-flow.md). For how Pipeline Builder benefits engineering organizations, see [Organization Benefits](docs/organization-benefits.md). For cut-and-paste pipeline examples by language, see [Developer Guide](docs/developer-guide.md).

---

## Quick Start

```bash
git clone <repo-url> pipeline-builder && cd pipeline-builder
pnpm install && pnpm build

cd deploy/local && chmod +x bin/startup.sh && ./bin/startup.sh
```

Open **https://localhost:8443** — register, create an org, and start building pipelines.

> **Prerequisites:** Node.js >= 24.9, pnpm >= 10.25, Docker

---

## Deployment Options

| Target | Best for | Cost |
|--------|----------|------|
| **[Local](deploy/local/)** | Development | Free |
| **[Minikube](deploy/minikube/)** | Local Kubernetes | Free |
| **[EC2](docs/aws-deployment.md#ec2)** | Dev/staging | ~$30-80/mo |
| **[Fargate](docs/aws-deployment.md#fargate)** | Production | ~$100-300/mo |

---

## Documentation

### Getting Started

| Document | Description |
|----------|-------------|
| [Overview](docs/README.md) | Key concepts, usage guides, operational how-to |
| [Developer Guide](docs/developer-guide.md) | Cut-and-paste pipeline examples for 7 languages |
| [Samples](docs/samples.md) | Pipeline configs and CDK patterns |
| [Organization Benefits](docs/organization-benefits.md) | What orgs gain from standardizing on the platform |
| [Architecture Flow](docs/architecture-flow.md) | End-to-end flow diagrams (request → build → deploy) |

### Developer Reference

| Document | Description |
|----------|-------------|
| [API Reference](docs/api-reference.md) | REST endpoints, query params, curl examples |
| [CDK Usage](docs/cdk-usage.md) | `PipelineBuilder` construct, sources, stages, VPC, IAM, secrets |
| [Metadata Keys](docs/metadata-keys.md) | 56 CodePipeline/CodeBuild configuration keys |
| [Template Syntax](docs/templates.md) | {% raw %}`{{ ... }}`{% endraw %} interpolation for pipeline configs and plugin specs |
| [Plugin Catalog](docs/plugins/README.md) | 124 pre-built plugins across 10 categories |

### Operations

| Document | Description |
|----------|-------------|
| [AWS Deployment](docs/aws-deployment.md) | EC2 and Fargate deployment guides |
| [Environment Variables](docs/environment-variables.md) | Full config reference for all services |
| [Compliance](docs/compliance.md) | Rule engine, validation, audit trail |

---

## License

Apache License 2.0 — see [LICENSE](LICENSE).
