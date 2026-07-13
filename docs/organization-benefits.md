---
layout: default
title: Organization Benefits
---

# Organization Benefits

How Pipeline Builder transforms CI/CD for engineering organizations.

---

## The Problem

Most organizations struggle with the same CI/CD challenges as they scale:

- **Every team builds pipelines differently.** No consistency in testing, scanning, or deployment patterns. Knowledge is siloed — when someone leaves, their pipeline becomes unmaintainable.
- **Security is opt-in.** Teams skip vulnerability scanning because it's hard to configure. There's no enforcement mechanism until something breaks in production.
- **AWS expertise is a bottleneck.** Setting up CodePipeline, CodeBuild, IAM roles, and Docker images requires deep AWS knowledge. Most developers don't have it and shouldn't need it.
- **No visibility across teams.** Leadership can't answer basic questions: How many pipelines do we have? What's the failure rate? Which teams have security scanning? What does CI/CD cost per team?
- **Vendor lock-in.** Third-party CI/CD platforms own the execution environment. Migrating away means rebuilding everything.

---

## How Pipeline Builder Solves It

### 1. Self-Service Pipeline Creation

Developers create production-ready pipelines without writing CDK, CloudFormation, or buildspec files.

| Interface | Use Case |
|-----------|----------|
| **Dashboard** | Visual builder — select plugins, configure stages, deploy |
| **AI Prompt** | Paste a Git URL, get a complete pipeline generated from repo analysis |
| **CLI** | `pipeline-manager create-pipeline` for scripted workflows |
| **REST API** | Programmatic control for platform teams |
| **CDK Construct** | `PipelineBuilder` for infrastructure-as-code |

A Java team gets build, test, lint, security scan, and deploy stages in minutes — not days.

### 2. Shared Plugin Catalog

119 pre-built, containerized plugins covering the full CI/CD lifecycle:

| Category | What It Covers |
|----------|---------------|
| **Language** (11) | Java (Corretto/Oracle), Python, Node.js, Go, Rust, .NET, C++, PHP, Ruby |
| **Security** (34) | Snyk, SonarCloud, Trivy, Semgrep, Veracode, Checkmarx, Fortify |
| **Quality** (17) | ESLint, Prettier, Checkstyle, Clippy, Ruff, ShellCheck |
| **Testing** (14) | Jest, Pytest, Cypress, Playwright, k6, Postman, Artillery |
| **Artifact** (16) | Docker, ECR, GHCR, npm, PyPI, Maven, NuGet, Cargo |
| **Deploy** (13) | Terraform, CloudFormation, Kubernetes, Helm, Pulumi, ECS, Lambda |
| **Notification** (5) | Slack, Microsoft Teams, email, PagerDuty, GitHub status |
| **Infrastructure** (5) | CDK synth, S3 cache, manual approval, shell |
| **Monitoring** (3) | Datadog, New Relic, Sentry |
| **AI** (1) | Multi-provider Dockerfile generation |

Every plugin is versioned, tested, and shared across the organization. Teams use the same tools instead of maintaining their own Docker images and build scripts.

### 3. Compliance Enforcement

The compliance engine validates every pipeline and plugin before creation — not after deployment.

**How it works:**
- Platform teams define rules: "all pipelines must include a security scan stage," "plugins must not use privileged containers," "pipeline timeout must not exceed 60 minutes"
- Rules evaluate against 18 operators (equality, contains, regex, numeric comparison, set membership, existence checks, not-empty, array/string length)
- Rules can combine multiple conditions (`all`/`any` mode), and specific plugins or pipelines can be granted scoped exemptions with an audit trail
- Violations at `error` or `critical` severity **block creation** (HTTP 403)
- Violations at `warning` severity log and allow

**What this means for the organization:**
- Security scanning is mandatory, not optional
- Compliance is enforced at the gate, not discovered in audit
- Platform teams set policy once — every team follows it automatically
- Audit trail captures every compliance decision

### 4. Multi-Team Isolation

Every resource is scoped to an organization with role-based access control:

| Resource | Isolation |
|----------|-----------|
| Pipelines | Scoped to (project, organization, orgId) |
| Plugins | Scoped by orgId + accessModifier (public/private) |
| Secrets | AWS Secrets Manager path: `{prefix}/{orgId}/{secretName}` |
| Quotas | Per-org limits on plugins, pipelines, API calls, AI calls, storage, and more |
| Compliance | Per-org rules and policies |
| Billing | Per-org subscription tiers and usage tracking |

Teams can't see or modify each other's resources. Public plugins are shared; private plugins are org-only. Organizations can also nest **teams** that share one account and pool their quotas — see [Organizations, Teams & Billing](#organizations-teams--billing) for the full model.

### 5. Zero Vendor Lock-In

Pipelines deploy as **native AWS CodePipeline + CodeBuild** in the customer's own AWS account.

- No proprietary runtime or agent
- No SaaS dependency at execution time
- If the organization stops using Pipeline Builder, every deployed pipeline keeps running
- Standard CloudFormation stacks — can be managed, modified, or deleted with normal AWS tools
- EventBridge events flow to the organization's own monitoring

### 6. Execution Analytics

EventBridge captures every CodePipeline and CodeBuild state change. Reports include:

- Execution counts and success rates per team/project
- Duration statistics — average, min, max, and p95 per pipeline
- Stage failure heatmaps — which stages fail most across the org
- Error categorization — grouping failures by message to surface recurring causes
- Plugin build success rates and durations across the catalog

---

## Organizations, Teams & Billing

Every resource in Pipeline Builder lives inside an **organization**, organizations can optionally nest **teams**, and each account carries a **billing** subscription that sets its caps. These three concepts work together: the organization is the boundary, teams share a boundary's resources under one account, and billing decides how much that account can do.

### Organizations

**Overview.** An organization is a self-contained, isolated workspace — your company, a business unit, or a single squad. It is the tenancy boundary: every pipeline, plugin, compliance rule, quota, secret, subscription, and analytics record belongs to exactly one organization, and organizations cannot see or modify each other's resources. A user can belong to several organizations and acts within one at a time (switch with the org switcher).

**Details.**

- **Roles (RBAC), enforced at the API layer:**

  | Role | Capabilities |
  |------|-------------|
  | **Owner** | Full control — manage members, transfer ownership, delete the organization (exactly one owner per org) |
  | **Admin** | Manage plugins, pipelines, compliance rules, and quotas; invite and manage members |
  | **Member** | Create and manage their own pipelines and plugins |

- **Roles.** Access is granted through **Roles** — each Role is a named set of fine-grained `resource:action` permissions. A user's effective permissions are the **union of the Roles assigned to them**; there is no separate role-based baseline. New orgs seed default Roles (Admin, Member); the system org also gets Super Admin; a platform Super Admin implicitly holds every permission. ("Role" is the user-facing name for what the API calls a permission group.)
- **What's scoped to the org:** pipelines (by project + orgId), plugins (by orgId + `public`/`private` access modifier), compliance rules and exemptions, quotas and seats, secrets (`pipeline-builder/{orgId}/{secretName}`), the billing subscription, and execution analytics.
- **The shared system organization** publishes a recommended plugin catalog and compliance-rule catalog that any organization can pull from or subscribe to — a common baseline without giving up isolation.
- **Membership** is per-organization: inviting a user into one org grants no access to another.

### Teams

**Overview.** A **team** is an organization nested one level under a parent (root) organization — the org → team hierarchy. Nesting is **opt-in**: by default every organization is a flat, top-level root with no teams. A team is a full organization (its own members, roles, and secrets), but it shares its parent's account — so the parent can govern it and quotas, billing, visibility, compliance, and analytics roll across the parent ↔ team relationship.

**Details.**

- **One level deep, and tier-gated.** Teams can't have sub-teams. A parent can only nest teams when it is on the **Team** or **Enterprise** tier — the tiers that include the org → team hierarchy.
- **One shared account.** A team inherits the parent's tier and feature entitlements, and its own quotas are set to unlimited so that **only the root's pooled caps bind** — the whole subtree draws from one shared pool rather than each team carrying separate limits.
- **Effective RBAC.** A parent-org **admin/owner** administers its teams (manage members, rules, quotas) without a separate membership; team-local roles still apply within each team. Members get no implied authority over sibling or parent orgs.
- **Inherited plugin visibility.** A team sees its parent's **private** plugins in addition to its own and the public catalog.
- **Compliance propagation.** A parent rule marked *apply to child teams* is enforced on every team in the subtree, on both live validation and scheduled scans.
- **Pooled quotas & seats.** Count quotas (plugins, pipelines, …) sum each team's usage against the root's cap; seats are counted as distinct active members plus pending invites across the whole subtree and checked at invite time. Registry storage is measured live across the subtree.
- **Rolled-up analytics.** A parent admin can include child-team execution data in reports.
- **Safe downgrades.** Downgrading a root that has teams to a tier that forbids teams (Developer/Pro) is blocked until the teams are resolved, so a tier change can't silently strand them.

### Billing

**Overview.** Each account (the root organization) carries a subscription **tier** that sets its baseline capabilities and caps, and can stack **add-on bundles** to raise specific caps or unlock features without changing tier. Teams don't have separate bills — they share the root account's subscription, and the effective limits are pooled across them.

**Details.**

- **Tiers** — Developer, Pro, Team, and Enterprise. Higher tiers raise every cap and unlock gated features:

  | | Developer | Pro | Team | Enterprise |
  |---|:---:|:---:|:---:|:---:|
  | **Price / month** | $0 | $19 | $49 | $99 |
  | Plugins | 25 | 50 | 100 | 250 |
  | Pipelines | 5 | 10 | 200 | 200 |
  | Member seats | 1 | 1 | 10 | 25 |
  | API calls / period | 25,000 | 500,000 | unlimited | unlimited |
  | AI calls / period | 50 | 2,500 | 10,000 | 25,000 |
  | Registry storage | 2 GB | 50 GB | 250 GB | 1 TB |
  | Dashboards | 20 | 200 | unlimited | unlimited |
  | Alert rules / destinations | 50 / 10 | 500 / 50 | unlimited | unlimited |
  | IdP configs | 1 | 5 | 5 | unlimited |
  | AI generation (pipelines & plugins) | — | ✅ | ✅ | ✅ |
  | Bulk operations | — | ✅ | ✅ | ✅ |
  | Audit log | — | — | ✅ | ✅ |
  | SSO | — | — | — | ✅ |
  | Custom integrations | — | — | — | ✅ |
  | Teams (org → team nesting) | — | — | ✅ | ✅ |
  | Priority support | — | ✅ | ✅ | ✅ |

  AI quotas are sized smaller than API quotas because AI calls carry an external per-call dollar cost. `-1` in the code means unlimited. System-org users always have every feature. Every limit and price is env-overridable (`QUOTA_TIER_<TIER>_<LIMIT>`, `BILLING_PLAN_<TIER>_MONTHLY`).

- **Add-on bundles** — stackable packs that adjust one dimension: Seat Pack (+5 seats), Pipeline Pack (+10), Plugin Pack (+100), API Pack (+1M calls), AI Pack (+5,000 calls), Storage Pack (+50 GB), plus the Audit Log and SSO feature bundles. **Effective limit = tier base + Σ(bundle grant × quantity)**, and the result pools across the account's teams. This lets an account that needs a little more headroom buy the pack instead of jumping a whole tier. See [Billing Add-on Bundles](billing-bundles.md) for the full catalog, prices, and pooling rules.
- **Enforcement.** Billing computes the effective entitlement and syncs it to the enforcing services — quota limits to the quota service, seats and purchased features to the platform service — always against the account root. Removing a bundle can't drop a cap below current pooled usage.

---

## Impact by Role

### Developers
**Before:** Spend days configuring CI/CD. Copy buildspecs from other repos. Debug IAM permissions. Manage Docker images for build tools.

**After:** Select plugins from a catalog. Deploy from the dashboard or CLI. Focus on application code, not infrastructure.

### Platform Engineers
**Before:** Maintain shared CI/CD templates. Handle template drift across teams. Respond to "my pipeline broke" tickets.

**After:** Manage the plugin catalog. Define compliance rules. Monitor execution analytics. The platform enforces standards automatically.

### Security Teams
**Before:** Audit pipelines manually. Chase teams to add scanners. Discover gaps after incidents.

**After:** Define compliance rules that mandate security scanning. Every pipeline is checked at creation time. Audit trail provides evidence for compliance reviews.

### Engineering Leadership
**Before:** No visibility into CI/CD health, costs, or adoption. Can't answer "are we secure?" with data.

**After:** Dashboards show pipeline health across the organization. Per-org billing tracks subscription and usage. Compliance reports prove security posture.

---

## Deployment Flexibility

| Target | Best For | Infrastructure |
|--------|----------|---------------|
| **Local** (Docker Compose) | Development, demos | Single machine, all services in containers |
| **Minikube** (K8s) | Testing, small teams | Single node Kubernetes, KEDA auto-scaling |
| **EC2** (Minikube on EC2) | Small-medium production | t3.2xlarge default (8 vCPU / 32 GiB), persistent storage, Let's Encrypt |
| **EKS** (Auto Mode) | Large-scale production | Managed Kubernetes, Karpenter autoscaling, EBS/EFS-backed PostgreSQL/MongoDB/Redis |

All deployment targets run the same services with the same configuration — `.env` files and K8s manifests are consistent across targets.

---

## Quantified Benefits

| Metric | Without Pipeline Builder | With Pipeline Builder |
|--------|-------------------------|----------------------|
| Time to first pipeline | 2-5 days | 5-15 minutes |
| Pipelines with security scanning | ~30% (opt-in) | 100% (enforced) |
| Unique CI/CD configurations | N (one per team) | 1 (shared plugin catalog) |
| Docker images to maintain | N (per team) | 0 (pre-built plugins) |
| AWS expertise required | Deep (CDK/CFN/IAM) | None (dashboard/CLI) |
| Visibility into CI/CD health | Manual/none | Real-time dashboards |
| Vendor lock-in | Yes (SaaS CI/CD) | None (native AWS resources) |

---

## Getting Started

```bash
git clone <repo-url> pipeline-builder && cd pipeline-builder
pnpm install && pnpm build
cd deploy/local/docker && chmod +x bin/setup.sh && ./bin/setup.sh
```

Open **https://localhost:8443** — register, create an org, and start building pipelines.

See [Architecture Flow](architecture-flow.md) for detailed system diagrams.
