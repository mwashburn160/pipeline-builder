---
layout: default
permalink: /
title: Pipeline Builder
description: Production-ready AWS CodePipelines from TypeScript, CLI, or a single AI prompt.
---

# Pipeline Builder

**Self-service CI/CD for AWS.** Pipeline Builder turns plugin definitions and pipeline configs into fully deployed AWS CodePipeline infrastructure — inside your own AWS account, with zero vendor lock-in.

[**View on GitHub**](https://github.com/mwashburn160/pipeline-builder) · [**Documentation**]({{ '/docs/' | relative_url }}) · [**Plugin Catalog**]({{ '/docs/plugins/' | relative_url }}) · [**API Reference**]({{ '/docs/api-reference.html' | relative_url }})

---

## Why Pipeline Builder

| Challenge | How Pipeline Builder solves it |
|-----------|-------------------------------|
| Developers need AWS expertise to set up CI/CD | Self-service pipeline creation via dashboard, CLI, API, or AI prompt |
| No governance over what gets deployed | Per-org compliance rules block non-compliant resources before deployment |
| Build steps are copy-pasted across teams | 124 reusable plugins shared and versioned across projects |
| Multi-team environments lack isolation | Every resource scoped to an organization with RBAC access control |
| Vendor lock-in with CI/CD platforms | Pipelines deploy as native AWS CodePipeline + CodeBuild in your own account |
| No visibility into CI/CD costs | Per-org quotas, billing integration, and execution analytics |

---

## Five ways to create a pipeline

| Interface | Description |
|-----------|-------------|
| **Dashboard** | Visual pipeline builder — point, click, deploy |
| **AI prompt** | Paste a Git URL, get a complete pipeline generated from your repo |
| **CLI** | `pipeline-manager create-pipeline` for scripted workflows and CI integration |
| **REST API** | Full CRUD + AI generation endpoints for programmatic control |
| **CDK construct** | `PipelineBuilder` construct for infrastructure-as-code |

---

## Get started

1. **Deploy** the platform — choose [Local]({{ '/docs/aws-deployment.html' | relative_url }}), Minikube, EC2, or Fargate
2. **Register** an admin user and organization
3. **Load plugins** from the catalog or upload your own
4. **Build pipelines** through the dashboard, CLI, API, or AI prompt

See the [full documentation]({{ '/docs/' | relative_url }}) for setup, deployment, and reference.

---

## Documentation

| Guide | Description |
|-------|-------------|
| [API Reference]({{ '/docs/api-reference.html' | relative_url }}) | REST endpoints for pipelines, plugins, compliance, reporting, and AI |
| [Compliance]({{ '/docs/compliance.html' | relative_url }}) | Per-org rule engine with 18 operators, computed fields, audit trail |
| [AWS Deployment]({{ '/docs/aws-deployment.html' | relative_url }}) | EC2 and Fargate deployment, drift detection, post-deploy setup |
| [CDK Usage]({{ '/docs/cdk-usage.html' | relative_url }}) | `PipelineBuilder` construct, sources, stages, VPC, IAM, secrets |
| [Metadata Keys]({{ '/docs/metadata-keys.html' | relative_url }}) | 56 CodePipeline / CodeBuild configuration keys |
| [Template Syntax]({{ '/docs/templates.html' | relative_url }}) | Synth-time interpolation for pipeline configs and plugin specs |
| [Plugin Catalog]({{ '/docs/plugins/' | relative_url }}) | 124 pre-built plugins across 10 categories |
| [Samples]({{ '/docs/samples.html' | relative_url }}) | Pipeline configs for 7 languages and CDK patterns |
