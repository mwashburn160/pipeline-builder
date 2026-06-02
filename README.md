<p align="center">
  <strong>Pipeline Builder</strong><br/>
  <em>Self-service AWS CodePipelines — from a dashboard, CLI, CDK construct, or a single AI prompt.</em>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-Apache%202.0-blue.svg" alt="License"></a>
  <img src="https://img.shields.io/badge/TypeScript-5.9-blue?logo=typescript&logoColor=white" alt="TypeScript">
  <img src="https://img.shields.io/badge/AWS%20CDK-2.257-orange?logo=amazonaws&logoColor=white" alt="AWS CDK">
  <img src="https://img.shields.io/badge/Node.js-%E2%89%A524.14-brightgreen?logo=nodedotjs&logoColor=white" alt="Node.js">
  <img src="https://img.shields.io/badge/Next.js-16-black?logo=nextdotjs&logoColor=white" alt="Next.js">
</p>

---

**Pipeline Builder is an organization-scoped CI/CD control plane — every pipeline, plugin, and policy lives inside an organization (with optional sub-organizations / teams) and compiles to native AWS CodePipeline + CodeBuild stacks deployed inside the client's own AWS account, with zero runtime lock-in.** Developers get pipelines in minutes; platform teams get enforcement, isolation, and analytics out of the box.

## At a Glance

| 125 | 5 | 4 | 12 | 17 |
|:---:|:-:|:-:|:--:|:--:|
| **plugins** ready to use | **interfaces** to create pipelines | **deploy targets** from laptop to Fargate | **AI models** for pipeline generation | **compliance operators** for guardrails |

## Why Pipeline Builder

| Challenge | How Pipeline Builder Solves It |
|-----------|-------------------------------|
| CI/CD set-up demands deep AWS expertise | Self-service creation via dashboard, CLI, REST API, CDK, or AI prompt — no CDK or buildspec knowledge required |
| Governance happens after the fact | Per-team compliance rules **block** non-compliant pipelines and plugins at creation time (HTTP 403), with full audit trail |
| Build steps get copy-pasted across teams | 125 versioned, containerized plugins shared from a central catalog — one source of truth, ten categories |
| Teams inside one organization share infrastructure without isolation | Every pipeline, plugin, secret, quota, and bill scoped to a sub-organization / team with RBAC and quota enforcement |
| Vendor lock-in with SaaS CI/CD platforms | Pipelines deploy as **native AWS CodePipeline + CodeBuild** in the client's account — keep running even if Pipeline Builder is removed |
| No visibility into CI/CD health or cost | EventBridge-fed analytics: success rates, duration percentiles, failure heatmaps, per-team cost attribution |

---

## Capabilities

### Five Ways to Build a Pipeline

Meet developers where they are — visual, scripted, declarative, or AI-driven. Same backend, same compliance, same audit trail.

| Interface | Best For | What You Do |
|-----------|----------|-------------|
| **Dashboard** | Application developers | Point, click, configure stages visually, deploy |
| **AI Prompt** | Brand-new repositories | Paste a Git URL — Pipeline Builder analyzes the repo and generates stages and plugins automatically |
| **CLI** | CI integration, scripting | `pipeline-manager create-pipeline` from any shell |
| **REST API** | Platform teams, automation | Full CRUD + AI generation endpoints |
| **CDK Construct** | Infrastructure-as-code shops | `PipelineBuilder` construct deployable from any CDK app |

### Multi-Provider AI Generation

Generate a complete pipeline — sources, stages, plugins, env vars — from a Git URL or natural-language prompt. Teams pick the provider that matches their procurement, data residency, or model preferences.

| Provider | Models |
|----------|--------|
| Anthropic | Claude Sonnet 4, Claude Haiku 4.5 |
| OpenAI | GPT-4o, GPT-4o Mini |
| Google | Gemini 2.0 Flash, Gemini 2.5 Pro |
| xAI | Grok 3, Grok 3 Fast, Grok 3 Mini |
| Amazon Bedrock | Claude 3.5 Sonnet v2, Nova Pro, Nova Lite |

### 125 Pre-Built Plugins, Ten Categories

Reusable build steps covering the full CI/CD lifecycle — language toolchains, security scanners, quality gates, test runners, artifact publishing, deployment, monitoring, and notifications. Every plugin runs as an isolated container step inside AWS CodePipeline, with secrets injected from AWS Secrets Manager at build time.

| Category | Count | Examples |
|----------|-------|---------|
| Language | 11 | Java, Python, Node.js, Go, Rust, .NET, C++, PHP, Ruby |
| Security | 40 | Snyk, SonarCloud, Trivy, Veracode, Semgrep, Checkmarx, Fortify |
| Quality | 17 | ESLint, Prettier, Checkstyle, Clippy, Ruff, ShellCheck |
| Testing | 14 | Jest, Pytest, Cypress, Playwright, k6, Postman, Artillery |
| Artifact & Registry | 16 | Docker, ECR, GHCR, npm, PyPI, Maven, NuGet, Cargo |
| Deploy | 13 | Terraform, CloudFormation, Kubernetes, Helm, Pulumi, ECS, Lambda, CDK |
| Infrastructure | 5 | CDK synth, manual approval, S3 cache, shell |
| Monitoring | 3 | Datadog, New Relic, Sentry |
| Notification | 5 | Slack, Teams, PagerDuty, email, GitHub status |
| AI | 1 | Dockerfile generation (multi-provider) |

### Synth-Time Templating

A minimal template language for pipeline configs and plugin specs — resolved **once at synthesis time** with no runtime evaluation, no shell-out, no code execution. Same engine, two scopes:

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

### Policy-as-Code Compliance Engine

Validate plugins and pipelines **before** they're created — not in a quarterly audit. Platform owners define policy at the organization level; every sub-organization / team inherits enforcement automatically.

- **17 operators** — equals, contains, regex, numeric comparison, value-in-set, field presence, array count, string length — plus computed fields (`$count`, `$length`, `$keys`, `$lines`) and cross-field conditions
- **Three severities** — `warning` (advisory), `error` / `critical` (block creation with HTTP 403)
- **Published rule catalog** — the platform organization publishes recommended rules; teams (sub-organizations) subscribe and opt-in per rule
- **Per-entity exemptions** — temporarily bypass a subscribed rule for a specific pipeline or plugin with audit
- **Bulk scans + audit trail** — sweep existing resources, generate evidence for compliance reviews
- **10 sample rules** included — security scanning required, privileged plugins blocked, naming conventions, timeout caps

### Organizations & Teams

Pipeline Builder is organized around two scopes: an **organization** (your company or business unit) and **sub-organizations / teams** that live inside it. Each user belongs to one or more teams; every pipeline, plugin, compliance rule, quota, secret, and bill is scoped to the team that owns it, and rolls up to the parent organization for cross-team visibility.

- **RBAC** — Owner, Admin, Member roles enforced at the API layer, per team
- **Feature tiers** — Developer, Pro, Unlimited (AI generation, bulk ops, audit log gated by tier)
- **Per-team quotas** — four dimensions: `plugins`, `pipelines`, `apiCalls`, `aiCalls` (AI sized smaller because external $ cost)
- **Public + private plugins** — share a plugin organization-wide or keep it scoped to a single team
- **Isolated secrets** — AWS Secrets Manager path `pipeline-builder/{orgId}/{secretName}` (per team), injected at build time, never stored in images

### Execution Analytics

Every CodePipeline and CodeBuild state change flows through EventBridge into the reporting service.

- Execution counts and success rates per team / project
- Duration percentiles (p50, p90, p99)
- Stage-level failure heatmaps — see which stages fail most across the organization
- Error categorization — build vs test vs deploy failures
- Per-team cost attribution that rolls up to the parent organization

### Built for Production

- **Zero-trust internal calls** — service-to-service HTTP uses short-lived JWTs minted via `signServiceToken()`; internal traffic satisfies the same `requireAuth` middleware as user requests (no per-route bypass)
- **Kubernetes-ready endpoints** — every service exposes `GET /health` (liveness), `GET /ready` (503 when any dependency is `disconnected`), `GET /warmup` (pre-opens connection pools), and `GET /metrics` (Prometheus scrape)
- **Graceful degradation** — readiness reflects real dependency state; load balancers route around partially-failed services automatically

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
| **Platform** | Auth, organizations, teams, users, JWT, RBAC — central gateway |
| **Pipeline** | Pipeline CRUD + AI generation + CDK synthesis |
| **Plugin** | Plugin CRUD + Docker image builds + AI generation |
| **Image Registry** | Stores and serves containerized plugin images with token-based auth, per-org storage quotas, and garbage collection |
| **Compliance** | Per-team rule enforcement (with org-level inheritance), policy management, audit trail |
| **Reporting** | Execution reports + build analytics via EventBridge |
| **Quota** | Resource limits per team |
| **Billing** | Subscriptions and plans per organization |
| **Message** | Organization and team announcements |

For detailed end-to-end flows (plugin upload, pipeline creation, CDK synthesis, CodePipeline execution), see [Architecture Flow](docs/architecture-flow.md). For how Pipeline Builder benefits engineering organizations, see [Organization Benefits](docs/organization-benefits.md). For cut-and-paste pipeline examples by language, see [Developer Guide](docs/developer-guide.md).

---

## Quick Start

```bash
git clone <repo-url> pipeline-builder && cd pipeline-builder
pnpm install && pnpm build

cd deploy/local && chmod +x bin/startup.sh && ./bin/startup.sh
```

Open **https://localhost:8443** — register, create an org, and start building pipelines.

> **Prerequisites:** Node.js >= 24.14, pnpm >= 10.33, Docker

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
| [Template Syntax](docs/templates.md) | `{{ ... }}` interpolation for pipeline configs and plugin specs |
| [Plugin Catalog](docs/plugins/README.md) | 125 pre-built plugins across 10 categories |

### Operations

| Document | Description |
|----------|-------------|
| [AWS Deployment](docs/aws-deployment.md) | EC2 and Fargate deployment guides |
| [Environment Variables](docs/environment-variables.md) | Full config reference for all services |
| [Compliance](docs/compliance.md) | Rule engine, validation, audit trail |

---

## License

Apache License 2.0 — see [LICENSE](LICENSE).
