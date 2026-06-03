---
layout: default
permalink: /
title: Pipeline Builder
description: Self-service AWS CodePipelines — from a dashboard, CLI, CDK construct, or a single AI prompt.
---

# Pipeline Builder

**An organization-scoped CI/CD control plane.** Every pipeline, plugin, and policy lives inside an organization (with optional sub-organizations / teams) and compiles to native AWS CodePipeline + CodeBuild stacks deployed inside your own AWS account — with zero runtime lock-in. Developers get pipelines in minutes; platform teams get enforcement, isolation, and analytics out of the box.

[**View on GitHub**](https://github.com/mwashburn160/pipeline-builder) · [**Documentation**]({{ '/docs/' | relative_url }}) · [**Plugin Catalog**]({{ '/docs/plugins/' | relative_url }}) · [**API Reference**]({{ '/docs/api-reference.html' | relative_url }})

---

## At a glance

| 125 | 5 | 4 | 12 | 18 |
|:---:|:-:|:-:|:--:|:--:|
| **plugins** ready to use | **interfaces** to create pipelines | **deploy targets** from laptop to Fargate | **AI models** for pipeline generation | **compliance operators** for guardrails |

---

## Why Pipeline Builder

| Challenge | How Pipeline Builder solves it |
|-----------|-------------------------------|
| CI/CD set-up demands deep AWS expertise | Self-service creation via dashboard, CLI, REST API, CDK, or AI prompt — no CDK or buildspec knowledge required |
| Governance happens after the fact | Per-team compliance rules **block** non-compliant pipelines and plugins at creation time (HTTP 403), with a full audit trail |
| Build steps get copy-pasted across teams | 125 versioned, containerized plugins shared from a central catalog — one source of truth, ten categories |
| Teams share infrastructure without isolation | Every pipeline, plugin, secret, quota, and bill scoped to a sub-organization / team with RBAC and quota enforcement |
| Vendor lock-in with SaaS CI/CD platforms | Pipelines deploy as **native AWS CodePipeline + CodeBuild** in your account — they keep running even if Pipeline Builder is removed |
| No visibility into CI/CD health or cost | EventBridge-fed analytics: success rates, duration percentiles, failure heatmaps, per-team cost attribution |

---

## Capabilities

### Five ways to build a pipeline

Same backend, same compliance, same audit trail — meet developers where they are.

| Interface | Best for | What you do |
|-----------|----------|-------------|
| **Dashboard** | Application developers | Point, click, configure stages visually, deploy |
| **AI prompt** | Brand-new repositories | Paste a Git URL — Pipeline Builder analyzes the repo and generates stages + plugins |
| **CLI** | CI integration, scripting | `pipeline-manager create-pipeline` from any shell |
| **REST API** | Platform teams, automation | Full CRUD + AI generation endpoints |
| **CDK construct** | Infrastructure-as-code shops | `PipelineBuilder` construct deployable from any CDK app |

### Multi-provider AI generation

Generate a complete pipeline — sources, stages, plugins, env vars — from a Git URL or a natural-language prompt. Pick the provider that matches your procurement, data-residency, or model preferences:

| Provider | Models |
|----------|--------|
| Anthropic | Claude Sonnet 4, Claude Haiku 4.5 |
| OpenAI | GPT-4o, GPT-4o Mini |
| Google | Gemini 2.0 Flash, Gemini 2.5 Pro |
| xAI | Grok 3, Grok 3 Fast, Grok 3 Mini |
| Amazon Bedrock | Claude 3.5 Sonnet v2, Nova Pro, Nova Lite |

### 125 pre-built plugins, ten categories

Reusable build steps covering the full CI/CD lifecycle. Every plugin runs as an isolated container step inside AWS CodePipeline, with secrets injected from AWS Secrets Manager at build time.

| Category | Count | Examples |
|----------|-------|----------|
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

See the [Plugin Catalog]({{ '/docs/plugins/' | relative_url }}) for the full list.

### Policy-as-code compliance

Validate plugins and pipelines **before** they're created — not in a quarterly audit. Platform owners define policy at the organization level; every team inherits enforcement automatically.

- **18 operators** — equals, contains, regex, numeric comparison, value-in-set, field presence, not-empty, array count, string length — plus computed fields (`$count`, `$length`, `$keys`, `$lines`) and cross-field conditions
- **Three severities** — `warning` (advisory), `error` / `critical` (block creation with HTTP 403)
- **Published rule catalog** teams subscribe to, **per-entity exemptions**, and **bulk scans + audit trail** for evidence

### Synth-time templating

A minimal `{{ ... }}` template language for pipeline configs and plugin specs — resolved **once at synthesis time**, with no runtime evaluation, no shell-out, no code execution. Path lookups (`pipeline.*`, `plugin.*`, `env.*`), `| default:` fallbacks, type coercion (`| number`, `| bool`, `| json`), and plugin contracts (`requiredMetadata` / `metadataTypes`) validated at upload. See [Template Syntax]({{ '/docs/templates.html' | relative_url }}).

### Organizations, teams & analytics

- **RBAC** — Owner / Admin / Member roles, enforced per team at the API layer
- **Per-team quotas** — `plugins`, `pipelines`, `apiCalls`, `aiCalls`; **feature tiers** (Developer / Pro / Unlimited)
- **Isolated secrets** — AWS Secrets Manager per team (`pipeline-builder/{orgId}/{secret}`), injected at build time, never stored in images
- **Execution analytics** — EventBridge-fed success rates, duration percentiles (p50 / p90 / p99), stage-level failure heatmaps, per-team cost attribution
- **Built for production** — zero-trust internal JWT auth, Kubernetes `health` / `ready` / `warmup` / `metrics` endpoints, graceful degradation

---

## Architecture

| Service | Purpose |
|---------|---------|
| **Platform** | Auth, organizations, teams, users, JWT, RBAC — central gateway |
| **Pipeline** | Pipeline CRUD + AI generation + CDK synthesis |
| **Plugin** | Plugin CRUD + Docker image builds + AI generation |
| **Image Registry** | Stores and serves plugin images with token auth, per-org quotas, garbage collection |
| **Compliance** | Per-team rule enforcement (with org-level inheritance), policy management, audit trail |
| **Reporting** | Execution reports + build analytics via EventBridge |
| **Quota / Billing / Message** | Resource limits, subscriptions, organization announcements |

See [Architecture Flow]({{ '/docs/architecture-flow.html' | relative_url }}) for end-to-end request → build → deploy diagrams.

---

## Get started

1. **Deploy** the platform — choose Local, Minikube, [EC2]({{ '/docs/aws-deployment.html' | relative_url }}), or Fargate
2. **Register** an admin user and organization
3. **Load plugins** from the catalog or upload your own
4. **Build pipelines** through the dashboard, CLI, API, or AI prompt

| Target | Best for | Cost |
|--------|----------|------|
| **Local** | Development | Free |
| **Minikube** | Local Kubernetes | Free |
| **EC2** | Dev / staging | ~$30–80/mo |
| **Fargate** | Production | ~$100–300/mo |

---

## Documentation

| Guide | Description |
|-------|-------------|
| [API Reference]({{ '/docs/api-reference.html' | relative_url }}) | REST endpoints for pipelines, plugins, compliance, reporting, and AI |
| [CDK Usage]({{ '/docs/cdk-usage.html' | relative_url }}) | `PipelineBuilder` construct, sources, stages, VPC, IAM, secrets |
| [Compliance]({{ '/docs/compliance.html' | relative_url }}) | Per-org rule engine with 18 operators, computed fields, audit trail |
| [Metadata Keys]({{ '/docs/metadata-keys.html' | relative_url }}) | 83 typed CodePipeline, CodeBuild, networking, and IAM configuration keys |
| [Template Syntax]({{ '/docs/templates.html' | relative_url }}) | Synth-time interpolation for pipeline configs and plugin specs |
| [AWS Deployment]({{ '/docs/aws-deployment.html' | relative_url }}) | EC2 and Fargate deployment, post-deploy setup |
| [Plugin Catalog]({{ '/docs/plugins/' | relative_url }}) | 125 pre-built plugins across 10 categories |
| [Samples]({{ '/docs/samples.html' | relative_url }}) | Pipeline configs for 7 languages and CDK patterns |
