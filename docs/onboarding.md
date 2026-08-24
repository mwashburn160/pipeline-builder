---
layout: default
title: Onboarding
---

# Onboarding a New Organization

The end-to-end path from a freshly deployed platform to a working organization with
your first pipeline. Each step links to the deep reference.

**Who this is for:** the first admin standing up an organization. If the platform
isn't deployed yet, start here — [`infra provision`](pipeline-manager.md#installing-the-platform-infra-provision)
is the recommended installer and covers most of the setup below in one command.

---

## The recommended path: `infra provision`

**[`pipeline-manager infra provision`](pipeline-manager.md#installing-the-platform-infra-provision)
is the default, recommended way to stand up the platform** — and it does far more
than deploy. In one command it deploys the target, **registers the initial `system`
admin login**, and (with the flags below) **loads the plugin catalog, compliance
rules, and sample pipelines**, plus wires up **event reporting** on AWS:

```bash
# Local / Minikube — deploy + register system admin + load plugins/compliance/samples
pipeline-manager infra provision --target docker \
  --admin-email admin@acme.com --admin-password 's3cret!' --with-all

# AWS (EC2/EKS) — same, plus the event-reporting bundle (store-token + setup-events)
pipeline-manager infra provision --target eks --region us-east-1 \
  --domain pipeline.example.com --hosted-zone-id Z123 \
  --admin-email admin@acme.com --admin-password 's3cret!' --with-all --with-events
```

When you provision this way, the platform-bootstrap steps are **already done** — you
don't run `init-platform.sh`, `store-token`, or `setup-events` by hand:

| What `infra provision` completes | Flag | Covers |
|---|---|---|
| Register the initial **`system` admin** login | `--admin-email` / `--admin-password` | **Step 1** |
| Load **plugins + compliance + samples** | `--with-all` | Step 1's catalog loads |
| **Store the service token** *(AWS)* | `--with-events` | **Step 5** |
| **Set up event reporting** *(AWS)* | `--with-events` | **Step 6** |

> `--init auto` is the default, so init happens automatically: on **EC2** the instance
> self-inits on first boot, on **EKS** in `setup.sh`'s final phase, and on
> **local/minikube** `provision` runs it for you. See
> [What `infra provision` handles](pipeline-manager.md#what-infra-provision-handles).

> **Per organization:** the `store-token` secret is scoped per org
> (`pipeline-builder/{orgId}/platform`). `--with-events` covers only the org you provisioned
> with. For **each new organization** you onboard, don't re-provision — run the standalone
> [`pipeline-manager infra store-token`](#step-5-store-the-service-token-aws-targets) and
> [`pipeline-manager infra setup-events`](#step-6-set-up-event-reporting-aws-targets)
> commands (Steps 5–6) to mint and wire that org's token.

**After provisioning, skip straight to [Step 2 — Create your organization](#step-2-create-your-organization).**
Steps 1, 5, and 6 below are the **manual equivalents** — for when you deployed the
platform by hand (raw `bin/setup.sh` + `init-platform.sh`) or are onboarding an
additional organization.

---

## At a glance

| # | Step | Automated by `provision`? | Manual tool |
|---|------|---------------------------|-------------|
| 1 | Register the initial `system` admin (+ load plugins/compliance/samples) | ✅ `--admin-email/-password` + `--with-all` | `init-platform.sh` |
| 2 | Create **your** organization | — you do this | Dashboard / API |
| 3 | Invite members & assign roles | — you do this | Dashboard / API |
| 4 | Create a Personal Access Token | — you do this | `auth pat` |
| 5 | Store the service token *(AWS)* | ✅ `--with-events` | `infra store-token` |
| 6 | Set up event reporting *(AWS)* | ✅ `--with-events` | `infra setup-events` |
| 7 | Create your first pipeline | — you do this | Dashboard / CLI / CDK |

Steps 5–6 apply to the AWS targets (EC2/EKS), where pipelines run on CodePipeline
and stream execution events back for analytics. Local/Minikube can skip them.

---

## Step 1 — Register the initial `system` admin *(manual installs only)*

**Provisioned with `infra provision`?** This is already done — skip to
[Step 2](#step-2-create-your-organization).

For a **manual install** (you ran `bin/setup.sh` yourself), `init-platform.sh`
registers the first admin into the reserved `system` organization and loads the
plugin catalog, compliance rules, and samples. Run it by hand only when you deployed
without `provision` (or provisioned with `--init manual`):

```bash
# Local / Minikube
./deploy/bin/init-platform.sh docker

# Set REAL admin credentials first on any shared/production target
PLATFORM_IDENTIFIER=admin@acme.com PLATFORM_PASSWORD='s3cret!' \
  ./deploy/bin/init-platform.sh minikube
```

> **Super-admin bootstrap:** the `system` org can only be created by an email listed in
> the platform's `BOOTSTRAP_SUPERADMIN_EMAILS`. On a fresh install, `PLATFORM_IDENTIFIER`
> **must** be in that list (the stock defaults `admin@internal` align). If you set a custom
> identifier, add it to `BOOTSTRAP_SUPERADMIN_EMAILS` and restart the platform first, or the
> registration is rejected (`403`). See [Post-Deploy: Initialize Platform](README.md#post-deploy-initialize-platform).

**Then log in** — from the dashboard (browse to your platform URL), or from the CLI:

```bash
# Persists the token to ~/.pipeline-manager/config.yml for subsequent commands.
eval $(pipeline-manager auth login -u admin@acme.com -p 's3cret!' --quiet)
```

See [Authentication & SSO](authentication.md) to add social login or enterprise SSO.

---

## Step 2 — Create your organization

`infra provision` sets up the `system` org and the shared catalog, but **your** tenant
organization is still yours to create — this is where onboarding a new org really begins.
Organizations are the isolation boundary — pipelines, plugins, compliance rules, quotas,
secrets, and billing are all scoped to one. The creator becomes the **owner**.

**Dashboard:** open the **Organizations** page → **Create Organization**.

**API:**

```bash
curl -X POST "$PLATFORM_BASE_URL/api/organization" \
  -H "Authorization: Bearer $PLATFORM_TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"acme-platform","displayName":"Acme Platform Team"}'
```

Nested **teams** (an org under a parent) are created from the **Members** page →
**Create Team**. See [Org → Team Hierarchy](README.md#teams-org-team-hierarchy).

---

## Step 3 — Invite members & assign roles

Invite by email from the dashboard (**Members** page) or the API. Access is granted
through **Roles** — named sets of `resource:action` permissions; a user's effective
permissions are the union of their assigned Roles. Every org seeds built-in **Admin**
and **Member** Roles; admins can add custom Roles.

See [Roles & Permissions](permissions.md) for the full model and the permission catalog,
and [Feature Tiers](README.md#feature-tiers) for what each tier/seat count unlocks.

---

## Step 4 — Create a Personal Access Token (PAT)

A PAT is a long-lived credential for CLI/CI/automation — use it instead of scripting a
password login. PAT creation is step-up-gated (re-auth with your password), so it's
interactive-safe:

```bash
pipeline-manager auth pat --name ci --expires-days 30 \
  -u admin@acme.com -p 's3cret!' --org <orgId>
```

The command prints an `export PLATFORM_TOKEN=…` line — capture it into your CI secret
store. Bind it to a specific org with `--org`. Rotate before expiry (`audit tokens`
warns you). Use `--quiet` to print only the export line for `eval`.

---

## Step 5 — Store the service token *(AWS targets)*

**Provisioned with `--with-events`?** This is already done — skip to
[Step 7](#step-7-create-your-first-pipeline).

> The in-app **onboarding step** (shown after you create an organization) surfaces
> this same `store-token` → `setup-events` sequence, with a with/without-DORA toggle
> — but only on the AWS targets (`DEPLOY_TARGET=aws-ec2`/`aws-eks`).

The plugin-lookup and event-ingestion Lambdas read a platform JWT from AWS Secrets
Manager (at `pipeline-builder/{orgId}/platform`). If you didn't pass `--with-events`,
mint and store it by hand:

```bash
# Log in first (or export a PAT as PLATFORM_TOKEN), then:
pipeline-manager infra store-token --days 30 --schedule --region us-east-1
```

`--schedule` also installs a small **daily auto-renewal** Lambda so the token never
lapses — recommended, since the event Lambda depends on it. Without it, re-run
`store-token` before expiry. Full detail: [Store Service Credentials](aws-deployment.md#2-store-service-credentials).

> After a fresh deploy (which rotates `JWT_SECRET`), re-run `store-token` before
> publishing plugins/pipelines, or image pulls can `401`.

---

## Step 6 — Set up event reporting *(AWS targets)*

**Provisioned with `--with-events`?** This is already done — skip to
[Step 7](#step-7-create-your-first-pipeline).

Otherwise, deploy the EventBridge → SQS → Lambda pipeline that streams
CodePipeline/CodeBuild execution events into the reporting service — this powers the
**Reports** dashboard (success rates, stage performance, DORA):

```bash
export PLATFORM_BASE_URL=https://pipeline.example.com
pipeline-manager infra setup-events --region us-east-1
```

It creates the `pipeline-builder-events` stack (EventBridge rule + SQS + DLQ + Lambda).
The Lambda authenticates via the Secrets Manager token from Step 5 — so run Step 5 first.

> **Measured lead time (optional — `--with-dora`):** add `--with-dora` to also resolve
> source commit timestamps in your AWS account, so the Reports page shows **measured**
> commit→deploy lead time (the fourth DORA metric). **Why it's a separate opt-in:**
> deployment frequency, change-failure rate, and MTTR all work without it — only lead
> time needs it, and it's off by default because it adds an SCM call + a `github-token`
> secret read on every deploy event (latency/cost). Enable it for orgs on the
> **Advanced Reporting** add-on; with it off, lead time simply reports `unknown`. Re-run
> `setup-events --with-dora` any time to toggle.

> **Privacy:** the Lambda runs inside your AWS account and forwards only execution
> telemetry (pipeline id, stage/action, status, timing, commit). Your **AWS account
> number and the pipeline ARN are never forwarded** — see
> [What is (and isn't) forwarded](aws-deployment.md#what-is-and-isnt-forwarded-to-the-platform).

Full detail: [Deploy EventBridge Reporting Infrastructure](aws-deployment.md#3-deploy-eventbridge-reporting-infrastructure) · [DORA Metrics](dora-metrics.md).

---

## Step 7 — Create your first pipeline

Five ways in — pick whichever fits ([Developer Guide → Five Ways](developer-guide.md#five-ways-to-create-a-pipeline)):

- **Dashboard** visual builder, or **AI prompt** ("build a Node service pipeline for …").
- **Golden-path template** — instantiate a governed starter by filling a few inputs ([Templates](templates.md#golden-pipeline-templates)).
- **CLI** — `pipeline-manager pipeline create` then `pipeline synth` / `pipeline deploy` (needs [local deploy prerequisites](pipeline-manager.md#prerequisites-for-local-pipeline-deploys)).
- **CDK** construct ([CDK Usage](cdk-usage.md)) or **REST API** ([API Reference](api-reference.md)).

If you provisioned with `--with-all`, the language [Samples](samples.md) are already
loaded as a starting point — remember each GitHub-source sample needs a `github-token`
secret ([sample prerequisites](samples.md#prerequisite-github-source-token)).

---

## Verify

- **Login works** — dashboard loads; `pipeline-manager status` is green.
- **Catalog loaded** — plugins, compliance rules, and samples appear (from `provision --with-all` or `init-platform.sh`).
- **Org is active** — it appears on the Organizations page; you're the owner.
- **Token stored** *(AWS)* — `pipeline-manager audit tokens` shows the platform token, not expiring soon.
- **Events flowing** *(AWS)* — after a pipeline runs, the **Reports** page shows executions; `audit stacks` shows `pipeline-builder-events`.

## Next steps

- Didn't load the catalog at provision time? [`infra provision --with-all`](pipeline-manager.md#what-infra-provision-handles) or `init-platform.sh` loads plugins/compliance/samples.
- Enforce standards before pipelines are created: [Compliance](compliance.md).
- Add [add-on bundles](billing-bundles.md) / [discounts](billing-discounts.md) to raise pooled caps.
- Operate it: [Deploy Operations runbook](deploy-operations.md).
