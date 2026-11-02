---
layout: default
title: API Quotas
---

<!--
Copyright 2026 Pipeline Builder Contributors
SPDX-License-Identifier: Apache-2.0
-->

# API Quotas

How every service meters and enforces the per-period call budgets — `apiCalls` for people, `automationCalls` for automation — which routes count, which deliberately don't, and what a client sees when a budget runs out.

## Highlights

- **Every authenticated user route meters and checks `apiCalls`.** One successful (2xx) call costs one; a call made when the budget is spent is refused with `429 QUOTA_EXCEEDED` before it does any work.
- **Automation spends its own budget.** A request made with an org **service-account** key is counted against `automationCalls` instead of `apiCalls` — never both — so a fleet of pipelines can't lock people out of the console.
- **Service-to-service traffic is free.** A peer service calling another on a user's behalf is never metered and never refused; the user's original call already paid.
- **The console doesn't spend your budget by itself.** A short, fixed list of polling reads (session bootstrap, the unread badge, SSE tickets…) is exempt — see [Exempt routes](#exempt-routes).
- **Machine ingest is metered, never refused.** CI telemetry and incident webhooks count toward `automationCalls` but are never dropped for quota.
- **Coverage is enforced by a test, not a convention.** Each service's route-coverage test fails on an unmetered or unchecked user route, and on any route metered twice.

## Overview

The quota service holds one counter per org per quota type per period (`QUOTA_RESET_DAYS`, 3 days by default), pooled at the account root for accounts with [teams](billing-bundles.md#pooling-across-teams). Tier baselines and [add-on bundles](billing-bundles.md) set the limits. This page covers the two **call** budgets; the count quotas (pipelines, plugins, dashboards, …) are reserved atomically by the route that creates the thing and are described with their features.

| Budget | Spent by | Raised by |
|--------|----------|-----------|
| `apiCalls` | People — browser sessions, personal access tokens (`pb_pat_…`) | Tier, API call packs |
| `automationCalls` | Org service accounts (`pb_sa_…`): self-mutating pipelines, registration, reporting ingest, registry push | Tier (sized for automation) |
| `aiCalls` | Any AI generation or Ask request — **in addition to** the `apiCalls`/`automationCalls` the call itself costs | Tier, AI call packs |

## How it works

### Where it is mounted

Each service mounts api-server's `apiCallsQuota(quotaService)` **once per URL prefix**, at the top of its `app-routes.ts`, ahead of every router under that prefix. It is two middlewares:

1. **The meter** (`meterQuotaOnSuccess`) increments the counter on response `finish`, only for a 2xx, only for a verified caller, never for a service principal, never for an idempotency-cache replay. Each increment carries attribution — principal, key, route pattern, pipeline and request id — for the [usage ledger](billing-bundles.md#seeing-what-used-a-quota-and-being-told-before-it-runs-out).
2. **The check** (`checkQuota`) is *armed* at the mount and *run* by `requireAuth` the moment it has verified the caller. Authentication is per route (a router mixes public, user and machine routes), so at mount time there is no verified org to check; checking an unverified one would leak a victim org's usage in the 429 body. A route that never authenticates never runs it.

| Service | Prefixes covered |
|---------|------------------|
| platform | `/user`, `/users`, `/organization` (incl. support contacts), `/invitation`, `/audit`, `/observability`, `/dashboards` |
| pipeline | `/pipelines`, `/pipeline-templates` |
| plugin | every user prefix (plugins, installs, publisher, reviews, queue status, pipeline security, exposures, triage, runtime check, security notifications, kept setup images) |
| message | `/messages` |
| compliance | `/compliance` |
| reporting | `/reports/*` user surfaces (settings, retention, deployments, stakeholder reports, executions, plugin reports, ingest health / incident admin reads) |
| image-registry | `/api/images` |

**Not metered:** platform's `/auth*` (sign-in, refresh, MFA, OAuth, SSO, device flow — a locked-out org must still be able to sign in), `/scim/v2` (directory sync has its own per-org bucket), `/config`, every `/internal/*` route, the system-org and vendor `/admin` surfaces, unauthenticated public routes, the quota service itself (reading your quota is always free) and billing.

### Machine ingest: metered, never refused

`POST /reports/events`, `POST /reports/ingest-health` and the incident webhooks (`POST /reports/incidents`, `…/alertmanager`) carry the `reporting:ingest` scope. They **meter** (a service-account key spends `automationCalls`) but are **not checked**. Dropping CI telemetry or an incident because a budget ran out loses deploy and incident history that can't be re-sent, and corrupts DORA; overshooting a call budget is the lesser harm, and the meter still makes the volume visible and billable.

### Exempt routes

The console makes these calls on every page load or on a timer. Metering them would burn an idle tab's budget all day, and checking them would leave a quota-exhausted org unable to render the banner telling it so. The list lives in api-core (`QUOTA_EXEMPT_ROUTES`) and is read by the meter, the check and the route table alike:

| Route | Why it is free |
|-------|----------------|
| `GET /user/profile` | Session bootstrap, every page load |
| `GET /user/organizations` | The org switcher, every page load |
| `GET /organization/:id/feature-entitlements` | Navigation gating, every page load |
| `GET /organization/:id/seat-usage` | Billing/quota page read beside the (free) quota reads |
| `GET /messages/unread/count` | Sidebar badge, polled every 30s when the live channel is down |
| `POST /messages/notifications/ticket` | SSE ticket, re-minted on every reconnect |
| `POST /reports/execution/stream/ticket` | SSE ticket, re-minted on every reconnect |

The quota banner's own poll (`GET /quotas`, every 60s) needs no entry: the quota service meters nothing.

### When a budget runs out

Every refusal — from the check or from a reservation — is the same response:

```http
HTTP/1.1 429 Too Many Requests
Retry-After: 172800
X-Quota-Limit: 25000
X-Quota-Used: 25000
X-Quota-Remaining: 0
X-Quota-Reset: 2026-11-05T00:00:00.000Z

{ "success": false, "code": "QUOTA_EXCEEDED", "message": "…",
  "details": { "quotaType": "apiCalls", "limit": 25000, "used": 25000,
               "resetAt": "2026-11-05T00:00:00.000Z", "upgradeUrl": "/dashboard/billing", "quota": { … } } }
```

`Retry-After` is the time to the period reset, not a back-off hint. A 429 **without** `code: QUOTA_EXCEEDED` is an ordinary rate limit.

- **Dashboard:** a global notice on every page names the quota and links to the upgrade page, whichever service refused.
- **CLI (`pipeline-manager`):** prints `API call quota reached (25,000/25,000); resets 2026-11-05. Upgrade: https://<platform>/dashboard/billing` and does not suggest retrying. A plain 429 keeps "rate limit exceeded — wait a moment". `synth`, `deploy`, `plugin verify` and `security-report upload` send `X-Pipeline-Id`, so the ledger attributes their calls to the pipeline.
- **Plugin-lookup Lambda:** a quota refusal fails the custom resource **immediately** with that same sentence as the CloudFormation `Reason` (retrying can't help); a plain 429 is retried, honouring `Retry-After` up to 10s.

### Threshold notices

Crossing 80% and 100% of a budget sends one notice per quota per period to the account root: an inbox message (message service), an **email to the root's admins/owners and billing contacts** (members whose Roles grant `billing:manage`, via platform's email relay), and a `quota.threshold` webhook when configured. Opt out on the root's Quotas page (`PUT /quotas/:orgId/notice-settings`).

## Configuration

| Setting | Effect |
|---------|--------|
| `QUOTA_TIER_<TIER>_API_CALLS`, `QUOTA_TIER_<TIER>_AUTOMATION_CALLS` | Per-tier budgets ([Environment variables](environment-variables.md)) |
| `QUOTA_RESET_DAYS` | Period length |
| `QUOTA_THRESHOLD_NOTICES_ENABLED` | Inbox/email/webhook threshold notices |

**Adding a route.** Put it under a prefix that already mounts `apiCallsQuota`, or mount it for the new prefix. Never add a per-route `meterQuotaOnSuccess(…, 'apiCalls')` under a covered prefix — the route-coverage test fails a route metered twice. A route that genuinely must not be metered or checked needs a `QUOTA_EXCEPTIONS` entry with its reason in that service's `test/route-coverage.test.ts`; a new console-polling read belongs in `QUOTA_EXEMPT_ROUTES`. The generated route tables (`frontend/src/generated/route-table/*.json`) show each route's `quota: { metered, checked, exempt }`.

## Related

- [Billing Add-on Bundles](billing-bundles.md) — limits, pooling, the usage ledger
- [Error Handling](error-handling.md) — the `QUOTA_EXCEEDED` error code
- [Service Mesh](service-mesh.md) — the internal routes the quota service calls (and is called on)
