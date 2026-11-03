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
- **Automation spends its own budget.** A request made with an org **service-account** key or a **personal access key** is counted against `automationCalls` instead of `apiCalls` — never both — so a fleet of pipelines or CI scripts can't lock people out of the console. Its cap is soft for a grace band (10% by default) before the 429.
- **Service-to-service traffic is free, and so is a forwarded hop.** A peer service calling another is never metered and never refused; nor is a user token an internal service forwards on the user's behalf (the Ask agent's tools, pipeline's placeholder-plugin confirm) — the user's original call already paid.
- **Cheap on the hot path.** Checks are cached per pod for a few seconds and time out fast (fail open); increments are summed per pod and sent once a second; the usage ledger stores hourly buckets, not one row per call.
- **The console doesn't spend your budget by itself.** A short, fixed list of polling reads (session bootstrap, the unread badge, SSE tickets…) is exempt — see [Exempt routes](#exempt-routes).
- **Machine ingest is metered, never refused.** CI telemetry and incident webhooks count toward `automationCalls` but are never dropped for quota.
- **Coverage is enforced by a test, not a convention.** Each service's route-coverage test fails on an unmetered or unchecked user route, and on any route metered twice.

## Overview

The quota service holds one counter per org per quota type per period (`QUOTA_RESET_DAYS`, 3 days by default), pooled at the account root for accounts with [teams](billing-bundles.md#pooling-across-teams). Tier baselines and [add-on bundles](billing-bundles.md) set the limits. This page covers the two **call** budgets; the count quotas (pipelines, plugins, dashboards, …) are reserved atomically by the route that creates the thing and are described with their features.

| Budget | Spent by | Raised by |
|--------|----------|-----------|
| `apiCalls` | People — browser sessions | Tier, API call packs, Member Seat |
| `automationCalls` | Non-interactive credentials — org service accounts (`pb_sa_…`: self-mutating pipelines, registration, reporting ingest, registry push) and personal access keys (`pb_pat_…`, and any token minted while holding one) | Tier (sized for automation), Automation Packs |
| `aiCalls` | Any AI generation or Ask request — **in addition to** the `apiCalls`/`automationCalls` the call itself costs | Tier, AI call packs |

## How it works

### Where it is mounted

Each service mounts api-server's `apiCallsQuota(quotaService)` **once per URL prefix**, at the top of its `app-routes.ts`, ahead of every router under that prefix. It is two middlewares:

1. **The meter** (`meterQuotaOnSuccess`) counts one unit on response `finish`, only for a 2xx, only for a verified caller, never for an idempotency-cache replay. Each unit carries attribution — principal, key, route pattern, pipeline — for the [usage ledger](billing-bundles.md#seeing-what-used-a-quota-and-being-told-before-it-runs-out).
2. **The check** (`checkQuota`) is *armed* at the mount and *run* by `requireAuth` the moment it has verified the caller. Authentication is per route (a router mixes public, user and machine routes), so at mount time there is no verified org to check; checking an unverified one would leak a victim org's usage in the 429 body. A route that never authenticates never runs it.

### What is not counted

Both halves skip the same requests (api-core `callQuotaExemption`), so the gate never refuses a call the meter would not bill:

- **Service principals** — internal service-to-service calls.
- **On-behalf hops.** A service that forwards the user's own token to a peer (the Ask agent's tools; pipeline's confirm-placeholder-plugins → plugin) adds an `X-PB-On-Behalf` header: a token **signed with the calling service's key**, typed so it can never be used as a bearer, bound to that user and org, valid 120 s, and honoured only from `ask` and `pipeline`. The peer skips the apiCalls meter and check for that request; tenancy, permissions and reservation quotas (a delegated generation still reserves its `aiCalls`) apply unchanged. A user who sets the header themselves gains nothing — it fails signature verification, is counted on `quota_on_behalf_rejected_total`, and the request is billed as usual. One Ask turn is therefore one `apiCalls` (plus its `aiCalls`), not one per tool call.
- **Impersonation sessions.** Vendor staff impersonating a user neither spend the tenant's call budget nor get refused by it — diagnosing an exhausted org must not be blocked by the exhaustion. The session is audited on its own trail.
- **Not-modified and unfinished responses.** A `304` from an ETag match is not a 2xx and is free. A response that never finishes — a client that aborts a stream, a dropped socket — never emits `finish` and is not counted.
- **Idempotent retries.** A retry of a completed `Idempotency-Key` mutation is answered from the replay cache: not metered, and not checked either (the check looks the key up first), so a client re-reading its own result is never 429'd.

### Hot-path cost: check cache, fast timeout, batched increments

- **Check cache.** Each pod reuses a check reading per (org, quota type): an *allowed* reading for `QUOTA_CHECK_CACHE_TTL_MS` (5 s), and only while the pod has passed fewer requests on it than the reading had headroom for; a *denied* reading until the period resets, capped at `QUOTA_CHECK_DENIED_CACHE_MS` (60 s) so an upgrade, a bundle or an operator reset is honoured within a minute. The trade is bounded staleness: a few requests per pod per TTL may pass after the counter fills. They are served, recorded as **overshoot**, and never counted past the cap.
- **Fast timeout.** A check read gets `QUOTA_CHECK_TIMEOUT_MS` (300 ms) and no retry, then fails open (counted on `quota_fail_open_total`, which alerts). `storageBytes` keeps the longer budget — it is a measured read behind the registry's fail-closed push gate.
- **Batched increments.** The meter does not call the quota service per request. Each pod sums units per (org, quota type, principal, key, route, pipeline) and every `QUOTA_INCREMENT_FLUSH_MS` (1 s) sends **one** metered increment per (org, quota type). The quota service applies it atomically against the (pooled) cap with **partial admission**: the counter moves by as much as fits and never past the cap; the remainder is recorded as `overshoot`. The counter can lag real usage by up to one flush interval. The buffer is bounded (`QUOTA_INCREMENT_BUFFER_MAX` groups — reaching it flushes early; only while a flush is in flight is a new group dropped, counted on `quota_increment_dropped_total`). A failed flush is counted on `quota_increment_failures_total` and not retried (it may have landed). Graceful shutdown flushes after the HTTP server drains. Reservations (`aiCalls`, `pipelines`, `plugins`, …) stay synchronous — they need the answer before the work runs.

### Automation calls

`automationCalls` defaults are sized from an itemized count of what one pipeline run calls with its keys — 12 plugin lookups, 1 synth, 1 runtime check, 1 security-report upload, 1 registry register and ~12 reporting-ingest batches = **28 calls per run** — at hourly runs for the 3-day period (2,016 per active pipeline), for 4 active pipelines per tier pipeline creation, plus the per-org ingest heartbeat (4,320 per period), with 25% headroom, rounded up to 10,000:

| Tier | Formula | Default |
|------|---------|--------:|
| Developer | (2×4×2,016 + 4,320) × 1.25 | 30,000 |
| Pro | (5×4×2,016 + 4,320) × 1.25 | 60,000 |
| Team | (10×4×2,016 + 4,320) × 1.25 | 110,000 |
| Business | (20×4×2,016 + 4,320) × 1.25 | 210,000 |
| Enterprise | (30×4×2,016 + 4,320) × 1.25 | 310,000 |

The cap is **soft**: at 100% the account gets the "reached" notice and automation keeps running up to `QUOTA_AUTOMATION_GRACE_PCT` (10%) over the limit; the 429 starts beyond that band. A self-mutating pipeline that hard-stopped at exactly 100% stayed stopped until the period reset — up to three days — so the band buys time to add an Automation Pack. Every other quota stays hard.

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

Crossing 80% and 100% of a budget sends one notice per quota per period to the account root: an inbox message (message service), an **email to the root's admins/owners and billing contacts** (members whose Roles grant `billing:manage`, via platform's email relay), and a `quota.threshold` webhook when configured. Opt out on the root's Quotas page (`PUT /quotas/:orgId/notice-settings`). Each quota pod remembers which notices it has already seen claimed this period, so an org pinned at its cap costs no notice lookups per refusal.

### Usage ledger

Usage is stored as **hourly buckets** (`quota_usage_buckets`): one document per org, hour, quota type, outcome and (principal, key, route, pipeline), incremented in place. Outcomes are `counted`, `denied` (a reservation refused at the cap), `overshoot` (metered calls already served that did not fit under the cap) and `refunded`. Denials, overshoots and refunds additionally keep a raw per-event row with the request id (`quota_usage_events`). `GET /quotas/:orgId/usage` and its CSV read the buckets, so a range's start is rounded down to its hour. Volume scales with the number of distinct active (principal × route × pipeline) combinations per hour, not with requests — about 32 MB for an account with 50 active combinations over the default 90-day retention (`QUOTA_USAGE_EVENT_RETENTION_DAYS`).

## Configuration

| Setting | Effect |
|---------|--------|
| `QUOTA_TIER_<TIER>_API_CALLS`, `QUOTA_TIER_<TIER>_AUTOMATION_CALLS` | Per-tier budgets ([Environment variables](environment-variables.md)) |
| `QUOTA_RESET_DAYS` | Period length |
| `QUOTA_AUTOMATION_GRACE_PCT` | Soft band above the `automationCalls` cap (default 10, 0 = hard) |
| `QUOTA_CHECK_CACHE_TTL_MS`, `QUOTA_CHECK_DENIED_CACHE_MS` | Per-pod check cache (5 s allowed / ≤ 60 s denied) |
| `QUOTA_CHECK_TIMEOUT_MS` | Check read budget before failing open (300 ms) |
| `QUOTA_INCREMENT_FLUSH_MS`, `QUOTA_INCREMENT_BUFFER_MAX` | Increment batching interval (1 s; 0 = per request) and buffer bound |
| `QUOTA_USAGE_EVENT_RETENTION_DAYS` | Usage-ledger retention (buckets and raw rows) |
| `QUOTA_THRESHOLD_NOTICES_ENABLED` | Inbox/email/webhook threshold notices |

**Adding a route.** Put it under a prefix that already mounts `apiCallsQuota`, or mount it for the new prefix. Never add a per-route `meterQuotaOnSuccess(…, 'apiCalls')` under a covered prefix — the route-coverage test fails a route metered twice. A route that genuinely must not be metered or checked needs a `QUOTA_EXCEPTIONS` entry with its reason in that service's `test/route-coverage.test.ts`; a new console-polling read belongs in `QUOTA_EXEMPT_ROUTES`. The generated route tables (`frontend/src/generated/route-table/*.json`) show each route's `quota: { metered, checked, exempt }`.

## Related

- [Billing Add-on Bundles](billing-bundles.md) — limits, pooling, the usage ledger
- [Error Handling](error-handling.md) — the `QUOTA_EXCEEDED` error code
- [Service Mesh](service-mesh.md) — the internal routes the quota service calls (and is called on)
