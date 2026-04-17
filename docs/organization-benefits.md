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

124 pre-built, containerized plugins covering the full CI/CD lifecycle:

| Category | What It Covers |
|----------|---------------|
| **Language** (11) | Java, Python, Node.js, Go, Rust, .NET, C++, PHP, Ruby |
| **Security** (40) | Snyk, SonarCloud, Trivy, Semgrep, Veracode, Checkmarx, Fortify |
| **Quality** (17) | ESLint, Prettier, Checkstyle, Clippy, Ruff, ShellCheck |
| **Testing** (14) | Jest, Pytest, Cypress, Playwright, k6, Postman, Artillery |
| **Artifact** (16) | Docker, ECR, GHCR, npm, PyPI, Maven, NuGet, Cargo |
| **Deploy** (11) | Terraform, CloudFormation, Kubernetes, Helm, Pulumi, ECS, Lambda |

Every plugin is versioned, tested, and shared across the organization. Teams use the same tools instead of maintaining their own Docker images and build scripts.

### 3. Compliance Enforcement

The compliance engine validates every pipeline and plugin before creation — not after deployment.

**How it works:**
- Platform teams define rules: "all pipelines must include a security scan stage," "plugins must not use privileged containers," "pipeline timeout must not exceed 60 minutes"
- Rules evaluate against 18 operators (equals, contains, regex, numeric comparison, array count)
- Violations at `error` or `critical` severity **block creation** (HTTP 403)
- Violations at `warning` severity log and allow

**What this means for the organization:**
- Security scanning is mandatory, not optional
- Compliance is enforced at the gate, not discovered in audit
- Platform teams set policy once — every team follows it automatically
- Audit trail captures every compliance decision

### 4. Multi-Tenant Isolation

Every resource is scoped to an organization with role-based access control:

| Resource | Isolation |
|----------|-----------|
| Pipelines | Scoped to (project, organization, orgId) |
| Plugins | Scoped by orgId + accessModifier (public/private) |
| Secrets | AWS Secrets Manager path: `{prefix}/{orgId}/{secretName}` |
| Quotas | Per-org limits on plugins, pipelines, API calls |
| Compliance | Per-org rules and policies |
| Billing | Per-org subscription tiers and usage tracking |

Teams can't see or modify each other's resources. Public plugins are shared; private plugins are org-only.

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
- Duration percentiles (p50, p90, p99)
- Stage failure heatmaps — which stages fail most across the org
- Error categorization — build failures vs test failures vs deployment failures
- Cost attribution per organization

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

**After:** Dashboards show pipeline health across the organization. Per-org billing tracks CI/CD costs. Compliance reports prove security posture.

---

## Deployment Flexibility

| Target | Best For | Infrastructure |
|--------|----------|---------------|
| **Local** (Docker Compose) | Development, demos | Single machine, all services in containers |
| **Minikube** (K8s) | Testing, small teams | Single node Kubernetes, KEDA auto-scaling |
| **EC2** (Minikube on EC2) | Small-medium production | t3.xlarge+, persistent storage, Let's Encrypt |
| **Fargate** (ECS) | Large-scale production | Serverless containers, managed scaling, RDS/DocumentDB |

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
cd deploy/local && chmod +x bin/startup.sh && ./bin/startup.sh
```

Open **https://localhost:8443** — register, create an org, and start building pipelines.

See [Architecture Flow](architecture-flow.md) for detailed system diagrams.
