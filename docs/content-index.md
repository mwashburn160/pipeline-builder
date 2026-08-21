---
layout: default
title: Content Index
---

# Content Index

A back-of-book **topic index** for the docs: find *where a subject is covered* by
keyword, including common synonyms. For a guided, narrative table of contents see
[docs/README.md](README.md); for the full grammar/reference of a feature, follow
the links below.

- **How to use:** scan for the term you'd search for (e.g. "mTLS", "secret naming",
  "buildArgs", "SSO"). Each entry points to the specific doc **and section**.
- **Tip:** in most editors `Ctrl/Cmd-F` on this page jumps straight to a keyword.

> Maintainers: this index is curated. When you add a doc or a major section, add a
> line here so the subject stays findable.

---

## A

- **Access control / access modifier (public vs private)** — [Permissions](permissions.md#the-model), [CDK: IAM Roles](cdk-usage.md#iam-roles)
- **Admin UIs (pgAdmin, Mongo Express)** — [Env vars: Admin UIs](environment-variables.md#admin-uis-infrastructure)
- **AI pipeline generation (prompt → pipeline)** — [Developer Guide: AI Prompt](developer-guide.md#2-ai-prompt), [API: AI Generation](api-reference.md#ai-generation), [AI Plugins](plugins/ai.md)
- **Ambient mesh** — see **Service mesh** → [Service Mesh](service-mesh.md#why-ambient-not-sidecars)
- **API reference (REST endpoints)** — [API Reference](api-reference.md#endpoints)
- **Architecture / system diagram / data flow** — [Architecture Flow](architecture-flow.md#system-architecture), [Service topology](service-mesh.md#architecture)
- **Artifact passing between steps** — [CDK: Artifact Passing](cdk-usage.md#artifact-passing-between-steps), [Artifact & Registry Plugins](plugins/artifact.md)
- **Audit events / audit log / tamper-evidence** — [Audit Events](audit-events.md), [Integrity](audit-events.md#integrity-tamper-evidence), [Action catalog](audit-events.md#action-catalog)
- **Authentication (login, JWT, OAuth)** — [Authentication & SSO](authentication.md), [Env vars: Authentication](environment-variables.md#authentication)
- **AWS deployment** — [AWS Deployment](aws-deployment.md), [EC2](aws-deployment.md#ec2), [EKS](aws-deployment.md#eks)
- **AWS Marketplace (metering, private offers)** — [Billing Discounts: Marketplace](billing-discounts.md#aws-marketplace-private-offers-handled-in-aws-not-in-app), [Env vars: Marketplace metering](environment-variables.md#aws-marketplace-metering-credit-realization)

## B

- **Backups & disaster recovery** — [Deploy Operations: Backups & DR](deploy-operations.md#backups-disaster-recovery)
- **Billing (plans, usage, credits)** — [Organization Benefits: Billing](organization-benefits.md#organizations-teams-billing), [Env vars: Billing](environment-variables.md#billing)
- **Bundles / add-on packs (seats, pipelines, API)** — [Billing Add-on Bundles](billing-bundles.md)
- **buildArgs (Docker build args, templatable)** — [Templates: build plugin with buildArgs](templates.md#example-build-plugin-with-buildargs)
- **BuildKit (rootless) / why rootless** — [Env vars: Why rootless BuildKit](environment-variables.md#why-rootless-buildkit)
- **Build queue (BullMQ / KEDA scaling)** — [Env vars: Build Queue](environment-variables.md#build-queue), [Mesh: Queues, KEDA & buildkit](service-mesh.md#queues-keda-buildkit)
- **Build types (Dockerfile vs shared base)** — [Architecture: Build Types](architecture-flow.md#build-types), [Plugins: Build Types](plugins/README.md#build-types)
- **BuilderProps (pipeline JSON shape)** — [CDK: BuilderProps Reference](cdk-usage.md#builderprops-reference), [Architecture: BuilderProps Structure](architecture-flow.md#builderprops-structure-stored-as-json-in-props-column)

## C

- **Caching (server-side)** — [Env vars: Caching](environment-variables.md#caching)
- **CDK construct / Infrastructure-as-Code** — [CDK Usage Guide](cdk-usage.md), [Infrastructure Plugins](plugins/infrastructure.md)
- **CLI (pipeline-manager)** — [Pipeline Manager (CLI)](pipeline-manager.md), [Command reference](pipeline-manager.md#command-reference)
- **CodeBuild step configuration** — [Metadata Keys: CodeBuild Step](metadata-keys.md#codebuild-step-configuration)
- **CodeCommit source** — [CDK: CodeCommit](cdk-usage.md#codecommit)
- **CodePipeline configuration** — [Metadata Keys: CodePipeline](metadata-keys.md#codepipeline-configuration)
- **CodeStar connection (GitHub/Bitbucket/GitLab)** — [CDK: CodeStar Connection](cdk-usage.md#codestar-connection-github-bitbucket-gitlab)
- **Compliance / policy-as-code / rules** — [Compliance Service](compliance.md), [Rule Schema](compliance.md#rule-schema), [Enforcement](compliance.md#enforcement)
- **Compute size (LARGE/MEDIUM)** — [Developer Guide: Custom Compute Size](developer-guide.md#custom-compute-size), [Metadata Keys: Build Environment](metadata-keys.md#build-environment)
- **Cross-account deployment** — [CDK: Cross-Account Deployments](cdk-usage.md#cross-account-deployments)
- **Cron / scheduled operator audits, drift** — [Pipeline Manager: Schedule drift detection](pipeline-manager.md#schedule-drift-detection-cron)

## D

- **Databases (Postgres, Mongo, Redis config)** — [Env vars: Databases](environment-variables.md#databases)
- **Deploy plugins (cloud, k8s, serverless)** — [Deploy Plugins](plugins/deploy.md)
- **Deployment modes (public vs private)** — [AWS Deployment: Deployment modes](aws-deployment.md#deployment-modes-public-vs-private)
- **Deploy operations runbook** — [Deploy Operations](deploy-operations.md)
- **Developer guide / getting started (dev)** — [Developer Guide](developer-guide.md), [Five ways to create a pipeline](developer-guide.md#five-ways-to-create-a-pipeline)
- **Developer portal (catalog ownership, scorecards)** — [Developer Portal](developer-portal.md)
- **Discounts / promo codes / referrals** — [Billing Discounts](billing-discounts.md), [Promotions](billing-discounts.md#promotions)
- **Docker registry (config, tags)** — [Env vars: Docker Registry](environment-variables.md#docker-registry), [Registry audit events](audit-events.md#registry-structured-log-events)
- **DORA metrics (deploy freq, lead time, MTTR, CFR)** — [DORA Metrics](dora-metrics.md), [Performance levels](dora-metrics.md#performance-levels)
- **Build health (per-pipeline stage success rate + timing percentiles)** — [DORA Metrics: Build health](dora-metrics.md#build-health)
- **Drift detection (CloudFormation stacks)** — [AWS Deployment: Drift Detection](aws-deployment.md#drift-detection-audit-stacks)

## E

- **EBS volume / expanding storage** — [AWS Deployment: Expanding EBS Volume](aws-deployment.md#expanding-ebs-volume)
- **EC2 deployment** — [AWS Deployment: EC2](aws-deployment.md#ec2)
- **EKS deployment** — [AWS Deployment: EKS](aws-deployment.md#eks), [EKS vs other k8s targets](aws-deployment.md#eks-vs-the-other-k8s-targets)
- **Egress (external, allow-any)** — [Service Mesh: External egress](service-mesh.md#external-egress)
- **Email / SES (sending, bounces, sandbox)** — [AWS Deployment: Email (SES)](aws-deployment.md#email-ses), [Env vars: Email](environment-variables.md#email)
- **Event reporting / `setup-events` (EventBridge → SQS → Lambda)** — [Onboarding: Set up event reporting](onboarding.md#step-6-set-up-event-reporting-aws-targets), [AWS: EventBridge Reporting](aws-deployment.md#3-deploy-eventbridge-reporting-infrastructure)
- **Encryption (per-team secret, KMS)** — [Metadata Keys: Encryption](metadata-keys.md#encryption), [Env vars: Multi-team secret encryption](environment-variables.md#multi-team-secret-encryption)
- **Environment variables (full reference)** — [Environment Variables](environment-variables.md)
- **Error handling / typed errors / error catalog** — [Error Handling Convention](error-handling.md), [Template error catalog](templates.md#error-catalog)
- **Exemptions (compliance waivers)** — [Compliance: Exemptions](compliance.md#exemptions)

## F

- **Failure behavior (fail / warn / ignore)** — [Developer Guide: Failure Behavior Options](developer-guide.md#failure-behavior-options)
- **Feature tiers (developer/pro/team/enterprise)** — [Docs: Feature Tiers](README.md#feature-tiers), [Organization Benefits](organization-benefits.md)
- **Filters (template `| default`, `| number`, `| bool`, `| json`)** — [Templates: Filters](templates.md#filters)

## G

- **GitHub source / token** — [CDK: GitHub](cdk-usage.md#github), [Samples: GitHub source token](samples.md#prerequisite-github-source-token)
- **Golden-path templates (reusable starters)** — [Developer Portal: Golden-path templates](developer-portal.md#golden-path-templates), [Templates: Golden pipeline templates](templates.md#golden-pipeline-templates)
- **Grammar (template syntax)** — [Templates: Grammar](templates.md#grammar)

## I

- **IAM roles (pipeline / step / action, OIDC)** — [CDK: IAM Roles](cdk-usage.md#iam-roles), [Metadata Keys: IAM Role](metadata-keys.md#iam-role-configuration), [Samples: IAM Role Levels](samples.md#iam-role-levels)
- **Infrastructure plugins (CDK synth, multi-region)** — [Infrastructure Plugins](plugins/infrastructure.md)
- **Initialize platform (post-deploy)** — [AWS Deployment: Initialize the Platform](aws-deployment.md#1-initialize-the-platform), [Docs: Post-Deploy](README.md#post-deploy-initialize-platform)
- **Interpolation (mixed literal + `{{ }}`)** — [Templates: Grammar](templates.md#grammar), [plugin `pipeline.*` interpolation](templates.md#example-plugin-spec-with-pipeline-interpolation)
- **Isolation (multi-team / per-org)** — [Architecture: Multi-Team Isolation](architecture-flow.md#multi-team-isolation), [Plugins: Multi-Organization Isolation](plugins/README.md#multi-organization-isolation)
- **Istio** — see **Service mesh** → [Service Mesh (Istio Ambient)](service-mesh.md)

## K

- **KEDA (autoscaling the build queue)** — [Service Mesh: Queues, KEDA & buildkit](service-mesh.md#queues-keda-buildkit)
- **Kiali (mesh visualization, optional)** — [Service Mesh: Optional Kiali](service-mesh.md#optional-kiali)
- **Kubernetes deploy plugins** — [Deploy Plugins: Kubernetes](plugins/deploy.md#kubernetes)

## L

- **Incident webhook (PagerDuty/Datadog/Alertmanager → automated CFR + MTTR)** — [Incident Webhook](incidents-webhook.md), [Correlation window](incidents-webhook.md#correlation-window)
- **Incident reporting setup (admin UI, self-serve token, per-org window)** — [Admin UI](incidents-webhook.md#admin-ui), [Getting a token](incidents-webhook.md#getting-a-token-self-serve), [Per-org window](incidents-webhook.md#per-org-correlation-window)
- **Incident webhook — Alertmanager adapter (native payload)** — [Alertmanager adapter](incidents-webhook.md#alertmanager-adapter-native)
- **Language plugins / version managers** — [Language Plugins](plugins/language.md)
- **Lead time (DORA caveat)** — [DORA Metrics: Lead Time caveat](dora-metrics.md#lead-time-caveat-roadmap)
- **LEAN mode (trim footprint — minikube & ec2)** — [Service Mesh: LEAN mode](service-mesh.md#lean-mode-trimming-the-footprint)

## M

- **Metadata keys (all scopes)** — [Metadata Keys](metadata-keys.md), [Scope Levels](metadata-keys.md#scope-levels)
- **Monitoring plugins** — [Monitoring Plugins](plugins/monitoring.md)
- **mTLS (mutual TLS between services)** — [Service Mesh: mTLS posture](service-mesh.md#mtls-posture)
- **Multi-region strategies (sequential/parallel/canary)** — [Infrastructure Plugins: Multi-Region](plugins/infrastructure.md#multi-region-strategies)
- **Multi-team / RLS context** — [Env vars: Multi-team RLS context](environment-variables.md#multi-team-rls-context)

## N

- **Network / VPC configuration** — [CDK: VPC and Network](cdk-usage.md#vpc-and-network-configuration), [Metadata Keys: Network](metadata-keys.md#network-configuration)
- **Notifications (Slack, email, alerts)** — [Compliance: Notifications](compliance.md#notifications), [Notification Plugins](plugins/notification.md), [Developer Guide: Slack Notifications](developer-guide.md#adding-slack-notifications)

## O

- **OAuth / social login** — [Authentication: OAuth social login](authentication.md#oauth-social-login-platform-wide), [Env vars: OAuth](environment-variables.md#oauth-social-login-optional)
- **OIDC (enterprise SSO, IAM role trust)** — [Authentication: Per-org SSO (OIDC)](authentication.md#per-org-enterprise-sso-oidc), [CDK: Role Types](cdk-usage.md#role-types)
- **Onboarding a new organization (initial login → PAT → events)** — [Onboarding](onboarding.md)
- **Organizations / teams / hierarchy** — [Docs: Organizations](README.md#organizations), [Organization Benefits](organization-benefits.md), [Permissions: Teams](permissions.md#teams)

## P

- **Pagination & limits** — [Env vars: Pagination & Limits](environment-variables.md#pagination-limits), [API: Common Query Parameters](api-reference.md#common-query-parameters)
- **PAT / Personal Access Token (CLI/automation credential)** — [Onboarding: Create a PAT](onboarding.md#step-4-create-a-personal-access-token-pat), [Pipeline Manager: auth](pipeline-manager.md#auth-infrastructure)
- **Permissions / RBAC / roles** — [Roles & Permissions](permissions.md), [Permission catalog](permissions.md#permission-catalog)
- **Pipeline creation (5 ways)** — [Developer Guide: Five Ways](developer-guide.md#five-ways-to-create-a-pipeline), [Docs: Creating Pipelines](README.md#creating-pipelines)
- **Plugins (catalog, categories, structure)** — [Plugin Catalog](plugins/README.md), [Categories](plugins/README.md#categories), by type: [AI](plugins/ai.md) · [Artifact](plugins/artifact.md) · [Deploy](plugins/deploy.md) · [Infrastructure](plugins/infrastructure.md) · [Language](plugins/language.md) · [Monitoring](plugins/monitoring.md) · [Notification](plugins/notification.md) · [Quality](plugins/quality.md) · [Security](plugins/security.md) · [Testing](plugins/testing.md)
- **Plugin contract (requiredMetadata / requiredVars / metadataTypes)** — [Templates: Plugin contract](templates.md#plugin-contract-declare-your-requirements)
- **Policies (compliance)** — [Compliance: Policies](compliance.md#policies)
- **Private vs public deployment** — [AWS Deployment: Deployment modes](aws-deployment.md#deployment-modes-public-vs-private)
- **Promotions / referrals** — [Billing Discounts: Promotions](billing-discounts.md#promotions)

## Q

- **Quality plugins (lint, format, coverage)** — [Code Quality Plugins](plugins/quality.md)
- **Quotas & rate limiting** — [Env vars: Quotas & Rate Limiting](environment-variables.md#quotas-rate-limiting)

## R

- **Redis (config, sentinel, HA)** — [Env vars: Redis](environment-variables.md#redis)
- **Registry (Docker image registry, tag copy/delete)** — [Env vars: Docker Registry](environment-variables.md#docker-registry), [Registry audit events](audit-events.md#registry-structured-log-events)
- **Reporting (execution & plugin reports)** — [AWS Deployment: Report API](aws-deployment.md#report-api-endpoints), [API: Reporting Endpoints](api-reference.md#reporting-endpoints)
- **Roles — RBAC (org permissions)** — [Roles & Permissions](permissions.md); **Roles — IAM (AWS)** — [CDK: IAM Roles](cdk-usage.md#iam-roles)
- **Rule schema (operators, computed fields)** — [Compliance: Rule Schema](compliance.md#rule-schema)

## S

- **Samples (pipeline + CDK examples)** — [Samples](samples.md), [Loading Samples](samples.md#loading-samples)
- **Scheduled pipelines (cron/EventBridge)** — [CDK: Scheduled Pipelines](cdk-usage.md#scheduled-pipelines)
- **Scopes (compliance / metadata scope levels)** — [Compliance: Scopes](compliance.md#scopes), [Metadata: Scope Levels](metadata-keys.md#scope-levels)
- **Secrets — usage & injection** — [CDK: Secrets Management](cdk-usage.md#secrets-management), [Plugins: How Secrets Work](plugins/README.md#how-secrets-work), [Env vars](environment-variables.md#authentication)
- **Service token (`store-token`, JWT in Secrets Manager)** — [Onboarding: Store the service token](onboarding.md#step-5-store-the-service-token-aws-targets), [AWS: Store Service Credentials](aws-deployment.md#2-store-service-credentials)
- **Secret naming convention (`pipeline-builder/{orgId}/{name}`)** — [Plugins: Naming Convention](plugins/README.md#naming-convention)
- **Secrets — rotation runbook** — [Deploy Operations: Rotation runbook](deploy-operations.md#rotation-runbook-there-is-deliberately-no-blind---rotate-flag)
- **Security plugins (SAST, SCA, secret detection)** — [Security Plugins](plugins/security.md)
- **Self-references (pipeline.json cross-refs)** — [Templates: pipeline-level self-references](templates.md#example-pipeline-level-self-references)
- **Service mesh (Istio ambient, mTLS, AuthZ)** — [Service Mesh](service-mesh.md), also [AWS](aws-deployment.md#service-mesh-istio-ambient) / [Ops](deploy-operations.md#service-mesh-istio-ambient)
- **Session invalidation (token revocation)** — [Permissions: Session invalidation](permissions.md#session-invalidation)
- **SSE / Server-Sent Events** — [Env vars: Server-Sent Events](environment-variables.md#server-sent-events)
- **SSO (single sign-on)** — see **OAuth** / **OIDC** → [Authentication & SSO](authentication.md)
- **Stages and steps** — [CDK: Stages and Steps](cdk-usage.md#stages-and-steps)
- **Storage requirements (disk sizing)** — [AWS Deployment: Storage (EC2)](aws-deployment.md#storage-requirements), [Storage (EKS)](aws-deployment.md#storage-requirements)
- **Synth-time templating** — see **Templates** → [Templates: Process overview](templates.md#process-overview-synth-time-resolution)

## T

- **Teams (org → team hierarchy, seats)** — [Docs: Teams](README.md#teams-org-team-hierarchy), [Permissions: Teams](permissions.md#teams)
- **Teardown (destroy a deployment)** — [AWS: EC2 Teardown](aws-deployment.md#teardown), [Deploy Operations: Teardown](deploy-operations.md#teardown)
- **Templates — syntax (`{{ }}`, vars, scopes)** — [Template Syntax](templates.md), [Scope reference](templates.md#scope-reference)
- **Templates — golden pipeline (starters)** — [Templates: Golden pipeline templates](templates.md#golden-pipeline-templates)
- **Testing plugins (unit, e2e, load, smoke)** — [Testing Plugins](plugins/testing.md)
- **Timeouts (build, upload chain)** — [Env vars: Timeouts](environment-variables.md#timeouts)
- **TLS (certs, renewal)** — [AWS: EC2 TLS](aws-deployment.md#tls), [EKS TLS Renewal](aws-deployment.md#tls-renewal)
- **Troubleshooting** — [AWS Deployment](aws-deployment.md#troubleshooting), [Service Mesh](service-mesh.md#troubleshooting), [Templates](templates.md#troubleshooting)

## V

- **Variables / `vars` (pipeline-level template variables)** — [Templates: Scope reference](templates.md#scope-reference), [pipeline-level self-references](templates.md#example-pipeline-level-self-references)
- **Version management (plugin versions)** — [Plugins: Version Management](plugins/README.md#version-management)
- **VPC / network** — [CDK: VPC and Network](cdk-usage.md#vpc-and-network-configuration)

---

## Documents at a glance

| Document | Covers |
|---|---|
| [README](README.md) | Narrative TOC — getting started, guides, key concepts |
| [api-reference](api-reference.md) | REST endpoints per service, query params, response format |
| [architecture-flow](architecture-flow.md) | End-to-end flows: plugin build, pipeline create, synth, execution |
| [audit-events](audit-events.md) | Audit action catalog, integrity, sensitive-data scrubbing |
| [authentication](authentication.md) | OAuth social login, per-org enterprise SSO (OIDC) |
| [aws-deployment](aws-deployment.md) | EC2 & EKS deploy, public/private modes, SES, reporting |
| [billing-bundles](billing-bundles.md) | Stackable add-on packs raising pooled caps |
| [billing-discounts](billing-discounts.md) | Discount codes, promotions, referrals, Marketplace offers |
| [cdk-usage](cdk-usage.md) | BuilderProps, sources, IAM, VPC, secrets, cross-account |
| [compliance](compliance.md) | Policy-as-code rules, scans, enforcement, exemptions |
| [content-index](content-index.md) | *This page — keyword/topic index* |
| [deploy-operations](deploy-operations.md) | Ops runbook: preflight, secrets rotation, backups, teardown |
| [developer-guide](developer-guide.md) | Five ways to create a pipeline, plugin cut-and-paste patterns |
| [developer-portal](developer-portal.md) | Catalog ownership, golden-path templates, scorecards |
| [dora-metrics](dora-metrics.md) | Deploy freq, lead time, MTTR, change-fail rate, build health |
| [incidents-webhook](incidents-webhook.md) | Incident webhook → automated post-deploy CFR + real MTTR |
| [environment-variables](environment-variables.md) | Every env var by subsystem |
| [error-handling](error-handling.md) | Typed `AppError` convention |
| [metadata-keys](metadata-keys.md) | All `aws:cdk:*` and step/pipeline metadata keys |
| [onboarding](onboarding.md) | New-org walkthrough: initial login → org → members → PAT → store-token → setup-events → first pipeline |
| [organization-benefits](organization-benefits.md) | Value story, orgs/teams/billing, impact by role |
| [permissions](permissions.md) | RBAC model, permission catalog, enforcement, sessions |
| [pipeline-manager](pipeline-manager.md) | CLI install, commands, workflows |
| [plugins/README](plugins/README.md) | Plugin catalog, secrets, structure, versioning |
| [samples](samples.md) | Language pipeline samples + CDK examples |
| [service-mesh](service-mesh.md) | Istio ambient, mTLS, L4 authorization, egress |
| [templates](templates.md) | `{{ }}` synth-time templating, scopes, filters, golden templates |
