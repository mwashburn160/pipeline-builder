---
layout: default
title: Onboarding
---

# Onboarding a New Organization

The end-to-end path from a freshly deployed platform to a working organization with
event reporting and your first pipeline. Each step links to the deep reference.

**Who this is for:** the first admin standing up an organization. If the platform
isn't deployed yet, start at [AWS Deployment](aws-deployment.md) (or
[`infra provision`](pipeline-manager.md#installing-the-platform-infra-provision)) and
come back here.

> **Already automated?** `pipeline-manager infra provision` runs Steps 1, 5, and 6
> for you when you pass `--admin-email/--admin-password` and `--with-events`. This
> guide is the manual, step-by-step equivalent — useful to understand what happens,
> or to onboard an additional org after the platform is up.

---

## At a glance

| # | Step | Where | Tool |
|---|------|-------|------|
| 1 | Create the initial admin login | Fresh install (once) | `init-platform.sh` / dashboard |
| 2 | Create your organization | Dashboard / API | UI or `curl` |
| 3 | Invite members & assign roles | Dashboard / API | UI or `curl` |
| 4 | Create a Personal Access Token | CLI | `auth pat` |
| 5 | Store the service token *(AWS)* | CLI | `infra store-token` |
| 6 | Set up event reporting *(AWS)* | CLI | `infra setup-events` |
| 7 | Create your first pipeline | Dashboard / CLI / CDK | any |

Steps 5–6 apply to the AWS targets (EC2/EKS), where pipelines run on CodePipeline
and stream execution events back for analytics. Local/Minikube can skip them.

---

## Step 1 — Create the initial admin login

On a **fresh install**, `init-platform.sh` registers the first admin into the reserved
`system` organization and loads the plugin catalog. The AWS targets self-run this by
default (EC2 on first boot, EKS in `setup.sh`'s final phase); local/minikube run it via
`infra provision`. You only run it by hand when you deployed with `--init manual`:

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

The plugin-lookup and event-ingestion Lambdas read a platform JWT from AWS Secrets
Manager (at `pipeline-builder/{orgId}/platform`). Mint and store it:

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

Deploy the EventBridge → SQS → Lambda pipeline that streams CodePipeline/CodeBuild
execution events into the reporting service — this powers the **Reports** dashboard
(success rates, stage performance, DORA):

```bash
export PLATFORM_BASE_URL=https://pipeline.example.com
pipeline-manager infra setup-events --region us-east-1
```

It creates the `pipeline-builder-events` stack (EventBridge rule + SQS + DLQ + Lambda).
The Lambda authenticates via the Secrets Manager token from Step 5 — so run Step 5 first.

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

Try the language [Samples](samples.md) as a starting point — remember each GitHub-source
sample needs a `github-token` secret ([sample prerequisites](samples.md#prerequisite-github-source-token)).

---

## Verify

- **Login works** — dashboard loads; `pipeline-manager status` is green.
- **Org is active** — it appears on the Organizations page; you're the owner.
- **Token stored** *(AWS)* — `pipeline-manager audit tokens` shows the platform token, not expiring soon.
- **Events flowing** *(AWS)* — after a pipeline runs, the **Reports** page shows executions; `audit stacks` shows `pipeline-builder-events`.

## Next steps

- Load the plugin catalog and samples: [`infra provision --with-all`](pipeline-manager.md#what-infra-provision-handles) or `init-platform.sh`.
- Enforce standards before pipelines are created: [Compliance](compliance.md).
- Add [add-on bundles](billing-bundles.md) / [discounts](billing-discounts.md) to raise pooled caps.
- Operate it: [Deploy Operations runbook](deploy-operations.md).
