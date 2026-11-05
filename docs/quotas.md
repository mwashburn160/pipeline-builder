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
- **AI calls are charged only on the platform's key.** A call served by the org's own provider key or the caller's request key (BYOK) spends no `aiCalls` — it is still recorded, with its model and tokens. See [AI calls](#ai-calls).
- **Registry storage is the one quota that does not reset.** It is a level, not a per-period allowance: it stays used until you free space or add capacity, and at the cap `docker push` is refused while existing images stay pullable. Usage counts each distinct image **layer once**, so publishing another version of a plugin costs little. See [Registry storage](#registry-storage).
- **Coverage is enforced by a test, not a convention.** Each service's route-coverage test fails on an unmetered or unchecked user route, and on any route metered twice.

## Overview

The quota service holds one counter per org per quota type per period (`QUOTA_RESET_DAYS`, 3 days by default), pooled at the account root for accounts with [teams](billing-bundles.md#pooling-across-teams). Tier baselines and [add-on bundles](billing-bundles.md) set the limits. This page covers the two **call** budgets and [registry storage](#registry-storage); the count quotas (pipelines, plugins, dashboards, …) are reserved atomically by the route that creates the thing and are described with their features.

| Budget | Spent by | Raised by |
|--------|----------|-----------|
| `apiCalls` | People — browser sessions | Tier, API call packs, Member Seat |
| `automationCalls` | Non-interactive credentials — org service accounts (`pb_sa_…`: self-mutating pipelines, registration, reporting ingest, registry push) and personal access keys (`pb_pat_…`, and any token minted while holding one) | Tier (sized for automation), Automation Packs |
| `aiCalls` | Any AI generation or Ask request — **in addition to** the `apiCalls`/`automationCalls` the call itself costs | Tier, AI call packs |
| `storageBytes` | Registry bytes your plugin images occupy — a **level**, not a per-period rate | Tier, Storage Packs |

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

### CPU credits

Every other budget on this page counts THINGS — pipelines, plugins, API calls.
`cpuCredits` counts **build compute**: one credit is one vCPU-minute, and a
plugin image build costs its wall-clock minutes multiplied by the vCPU its
builder occupies, rounded up to the whole credit. At the shipped 1.5 vCPU that
is about 2 credits a minute, so a ten-minute build costs 15.

The unit is deliberately abstract rather than "build minutes". The figures only
work as minutes if you also know the vCPU behind them — "11,250 build minutes"
reads as 187 hours when it buys about 125 — so the budget is denominated in the
thing actually being rationed and the surfaces convert for you when they explain
a cost.

| Tier | CPU credits / month | Roughly |
|------|--------------------:|---------|
| Developer | 4,500 | 100 ten-minute builds |
| Pro | 11,250 | 250 |
| Team | 22,500 | 500 |
| Business | 45,000 | 1,000 |
| Enterprise | 67,500 | 1,500 |

A **CPU Credits Pack** adds 500 credits a month on any tier and stacks (with a
volume discount from five packs). The `plugins` and `pipelines` packs carry
credits of their own, sized so a pack that lets you build more plugins also
pays for building them.

**The window is a month, not three days.** Credits are the one budget on a
30-day period (`QUOTA_CPU_CREDITS_PERIOD_DAYS`) while everything else rolls on
`QUOTA_RESET_DAYS`; a build budget that reset ten times a month would be ten
separate small budgets, which is not what a monthly figure means. The Quotas
page says "monthly" for this one and names the three-day window for the rest.

**Scope: plugin image builds only, today.** Pipeline executions run in AWS
CodeBuild and are **not counted yet** — their consumption is measured but
charged to nothing. When it is charged, every tier is re-derived in the same
release and the change is announced; the denominator changing silently is the
one thing that would not be acceptable.

#### What is charged, and what is not

- **A failed build IS charged** when the failure is yours — a broken Dockerfile,
  a refused scan gate. It occupied the builder exactly as a success would.
- **A retry we caused is NOT charged.** A retryable failure (a Redis blip, a
  registry timeout) is the platform's, and charging it would bill you for our own
  retry. Without that distinction a job retried to exhaustion would charge once
  per attempt.
- **Sample-catalog and install-time builds are exempt**, so a fresh install does
  not spend your first budget on its own seed data.
- **The build machine multiplies the charge, and the arithmetic runs one way in
  each direction.** Five machines are available — **Small, Standard, Medium,
  Large, X-Large** — metered at 0.5x, 1x, 2x, 4x and 8x the vCPU. Above Standard
  a build that parallelises finishes sooner for roughly the same credits and one
  that does not costs the multiple, so **a bigger machine can never cost less**.
  Below Standard it mirrors: a CPU-bound build takes twice as long at half the
  vCPU and costs the *same*, while an I/O-bound one costs about half, so **Small
  can never cost more**. That is why Small is offered on every tier as a budget
  option, and why a bigger machine is never suggested without measured speedup
  for that plugin.
- **A machine you cannot be given is refused, not substituted.** Each machine is
  a separate build daemon, so one the deployment has not provisioned is refused
  at submission. Serving it from the standard daemon would be wrong both ways:
  you would pay the multiple for standard speed, or get standard speed at a
  fraction of the price.
- **Small gets proportionally longer to finish.** The build deadline scales with
  the machine below Standard, so choosing the cheap option does not turn a long
  build into a timeout.

#### Build capacity is separate, and is not a budget

Two limits bound builds, and only one of them is spent:

- **CPU credits** are a budget. Out of credits means a build is refused at
  submission; a pack or the window reset fixes it.
- **Build slots** are capacity. Each organization may hold a few builds in
  flight at once, per scheduling class — **Standard** (starts as soon as a slot
  is free) and **Flexible** (starts later, with more room) — and a build over
  that cap WAITS rather than being refused: there is nothing to buy and nothing
  to fix. Small defaults to Flexible, because a half-speed build holds its slot
  about twice as long and would otherwise block the single Standard slot a free
  account keeps for an urgent fix. The Quotas page shows the counts under "Build
  capacity"; the refusal messages say which of the two you have hit, because the
  remedies are not the same.

Two builds submitted at the same instant can both be admitted at the cap and
each overshoot by its own cost, because admission checks the counter rather than
reserving against it — a build's cost is not known until it has run. The
overshoot is bounded by the slot caps and the per-build wall-clock bound, comes
to at most a few percent of a period, is always in your favour, and is recorded
in the usage ledger rather than hidden.

### Registry storage

Every other budget on this page is a per-period **flow**: it resets on `QUOTA_RESET_DAYS` and an account that hits one self-heals. `storageBytes` is a **stock** — it stays exactly where it is until you free space or buy capacity. That difference drives everything below, and it is why the Quotas page shows "Does not reset" for it instead of a reset date.

| Tier | Registry storage |
|------|------------------|
| Developer | 2 GB |
| Pro | 25 GB |
| Team | 60 GB |
| Business | 120 GB |
| Enterprise | 250 GB |

A **Storage Pack** adds 10 GB on any tier, including Developer, and stacks (with a volume discount from four packs). Operators can override a tier with `QUOTA_TIER_<TIER>_STORAGE_BYTES` or a single org through the quota API.

**With teams, the figure is the account's.** Limits pool at the account root, so the number above is what the root and all its teams hold **together** — the usage shown on your Quotas page is the whole account's, and the 80% / 100% notices are computed from it. (Enforcement at push time follows the same figure once the operator enables `QUOTA_STORAGE_ACCOUNT_BUDGET`; until then each namespace is checked against the pooled number on its own, which is more generous.)

#### How the number is calculated — and why it is in your favour

Usage is **the sum of unique image layers, counted once each**, not the sum of your images' sizes. Ten versions of a plugin that share a 400 MB base layer cost about 400 MB plus each version's own deltas — not 4 GB. Publishing a plugin to the marketplace does not double anything either: the public copy references the same bytes.

The practical consequence is worth planning around:

- **Publishing another version of an existing plugin is cheap** — only its changed layers are new.
- **Changing a base image is expensive** — it is a new set of layers for every plugin that moves to it.
- **A published plugin keeps costing you** after you delete your private copy, because the published repository still references those bytes. Freeing them means unlisting or withdrawing the publication, not deleting a version.

The figure covers your organization's own namespace plus the public repositories it has published. Anonymous marketplace submissions awaiting moderation are the platform's, never billed to a tenant.

#### What happens at the cap

Enforcement is in the registry, at the moment a token is issued:

- **Pushes are refused; pulls are not.** At the cap the registry issues a token with `push` removed and `pull` intact, so existing images stay reachable and running pipelines are unaffected. A `docker push` then fails with a **403** from the registry protocol, which cannot carry an explanation — so if a push starts failing and nothing changed about your credentials, check your storage figure first. The platform records the reason on its side with the byte numbers, so support can confirm it immediately.
- **There is a grace band.** Pushes keep working to 10% above the cap (`QUOTA_STORAGE_GRACE_PCT`) before being refused. Because storage never resets, that band is a **one-time** buffer to prune or buy in — not a recurring allowance.
- **An unverifiable cap refuses.** If the quota service cannot be reached, or the usage scan is incomplete (which would under-count), the push is refused rather than allowed.
- **You are told before it happens.** Storage crosses the same 80% and 100% [threshold notices](#threshold-notices) every other quota uses, on the same channels, with the same opt-out.

#### How to free space

1. **Retire plugin versions you no longer need.** A version that any pipeline references cannot be removed — update the pipeline first. Deleting a version frees only the layers *unique to it*, which is why the prune surface shows the bytes each removal would actually recover rather than the version's apparent size.
2. **Unlist or withdraw a publication** to stop paying for its public bytes.
3. **Add a Storage Pack** at `/dashboard/billing`, which takes effect within a minute.

Cancelling a Storage Pack or downgrading a tier is **refused** when it would leave you over the cap — storage cannot shrink on its own, so the alternative is an account that works until its next push.

### Threshold notices

Crossing 80% and 100% of a budget sends one notice per quota per period to the account root: an inbox message (message service), an **email to the root's admins/owners and billing contacts** (members whose Roles grant `billing:manage`, via platform's email relay), and a `quota.threshold` webhook when configured. Opt out on the root's Quotas page (`PUT /quotas/:orgId/notice-settings`). Each quota pod remembers which notices it has already seen claimed this period, so an org pinned at its cap costs no notice lookups per refusal.

### AI calls

`aiCalls` is a **reservation** quota: every AI surface — Ask how-to (`feature: ask`), an Ask agent turn (`agent`), an agent tool that generates in-process (`agent-tool:propose_template`), pipeline and plugin generation (`pipeline-generate`, `plugin-generate`) and stakeholder-report summaries (`report-summary`) — goes through one helper (api-server `withAiCallReservation` / `reserveAiCallSlot`) that:

1. **Resolves the model first.** Whose key serves the call decides the charge, so the selection (request key › org key › platform key) happens before any reservation; an AI-off org or an unloadable org key fails here with nothing reserved.
2. **Waives the slot** when the call costs the platform nothing — the call is still audited (`quota.slot: "waived"`, `waived: byok | impersonation | unweighted`), counted on `ai_quota_waived_total{feature,reason}`, and recorded in the usage ledger with zero units, its model, key source and tokens:
   - **BYOK** — `keySource` `org` or `request`: the customer pays the provider. The route's ordinary `apiCalls` is still charged.
   - **Impersonation** — a sysadmin impersonation session (`impersonatorId`), mirroring the `apiCalls` exemption.
   - **Weight 0** — the model's `AI_MODEL_WEIGHTS` weight is 0. By default that is the self-hosted OpenAI-compatible provider (`ask-model`), which runs on hardware the operator already pays for.
3. **Otherwise reserves the model's weight** in units — 1 unless `AI_MODEL_WEIGHTS` says otherwise — attributed to the route, principal, feature, model and key source. The slot is **kept once the provider responded** and refunded (with the same attribution) when it never did.
4. **Reports the tokens after the call** (`slot.reportUsage`): a zero-unit `report` write on the quota service's internal increment route that adds `tokensIn` / `tokensOut` to the call's hourly bucket. A lost report is counted on `quota_usage_report_failures_total`; enforcement is unaffected.

**What each surface costs.** One Ask turn: one unit for the agent's reasoning, plus one per delegated generation it drafts (`propose_pipeline`, `propose_plugin`, `propose_*_from_repo` — each a separate model call) and one per in-process `propose_template` (its own slot, settled by the same keep-on-contact rule, its tokens on the turn's `ask.agent.turn` audit row as `toolGenerations`). `propose_plugin_from_repo` reads its repository analysis from the AI-free `POST /pipelines/analyze/from-url` (apiCalls only), so it costs one unit beyond the turn, not two. A scheduled report summary is attributed to the definition's **owner** (`principalId`, route `schedule:report-summary`) and draws on that owner's per-member share when one is set; a manual (re)draft is attributed to the request.

**Who pays.** `aiCalls` is one pool per account: a service account calling `/generate` draws on the same pool as people (an AI call costs the same whoever makes it). The usage breakdown keeps them apart — every bucket carries `principalType`, so `groupBy=principal` shows `service_account` rows separately.

**Optional controls** — all off by default, set by a billing contact on the account root (`PUT /quotas/:orgId/notice-settings`, `billing:manage`, audited as `quota.notice_settings.update`; `null` clears one):

| Setting | Effect | Refusal |
|---|---|---|
| `aiCallsPerMemberPct` (1–100) | One **person** may spend at most this percent of the account's `aiCalls` limit per period (floor of 1 call). Read from the ledger (the member's counted − refunded units this period, across the account); service accounts are exempt. | `429 AI_MEMBER_SHARE_EXCEEDED` — "You've used your share of the organization's AI calls…" |
| `aiTokenBudget` | Platform-key tokens (in + out) the account may spend per period. Checked before each reservation against what the period's reports already summed, so a call in flight can carry the total past it once. | `429 AI_TOKEN_BUDGET_EXCEEDED` |
| `AI_MODEL_WEIGHTS` (env) | Model-class weighting: JSON `key → integer weight` (0–100), e.g. `{"opus":3,"sonnet":1,"haiku":1}`. A key equal to the provider id wins, else the longest key contained in the model id; no match = 1. Built-in: `{"openai-compatible":0}` (override it to meter the self-hosted model). | — (a heavier call reserves more units of the same cap) |

Both 429s carry `Retry-After` (time to the period reset) and `details.quota` (`limit` = the share or budget, `used`, `remaining`, `resetAt`). The two controls are soft pre-checks in front of the atomic counter reservation — two concurrent calls from one member at the edge of the share can both pass, but the account cap itself stays exact. A failed read of either fails open (`quota_ai_controls_fail_open_total`).

**Size bounds.** Each unit's input is bounded, so a unit can't carry an unbounded bill: Ask's client-held `history` totals at most 32,000 characters (20 messages × 8,000 each), a refinement's `previousConfig` at most 64,000 serialized characters, and every model call is capped at `ASK_MAX_OUTPUT_TOKENS` / `AI_MAX_OUTPUT_TOKENS`.

**Not metered, by design.** The CLI agent in `pipeline-manager` runs on the operator's own local provider keys and never calls the platform's AI routes. The Dockerfile-generating AI plugin runs inside the customer's CodeBuild on the customer's keys. Neither touches `aiCalls`.

### Usage ledger

Usage is stored as **hourly buckets** (`quota_usage_buckets`): one document per org, hour, quota type, outcome and (principal, key, route, pipeline — plus, for AI calls, feature, model and key source), incremented in place. AI buckets also sum `tokensIn` / `tokensOut` from the after-the-call reports. Outcomes are `counted`, `denied` (a reservation refused at the cap), `overshoot` (metered calls already served that did not fit under the cap) and `refunded`. Denials, overshoots and refunds additionally keep a raw per-event row with the request id (`quota_usage_events`). `GET /quotas/:orgId/usage` and its CSV read the buckets, so a range's start is rounded down to its hour. `groupBy` is `principal`, `route`, `pipeline`, `day`, `feature` or `model` (one row per model × key source, so a BYOK model is its own row); every group carries `tokensIn` / `tokensOut`, feature groups `feature`, model groups `model` and `keySource`, and the CSV adds the same columns. Volume scales with the number of distinct active (principal × route × pipeline) combinations per hour, not with requests — about 32 MB for an account with 50 active combinations over the default 90-day retention (`QUOTA_USAGE_EVENT_RETENTION_DAYS`).

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
| `AI_MODEL_WEIGHTS` | `aiCalls` units per model class (default: every model 1, the self-hosted provider 0) — see [AI calls](#ai-calls) |

**Adding a route.** Put it under a prefix that already mounts `apiCallsQuota`, or mount it for the new prefix. Never add a per-route `meterQuotaOnSuccess(…, 'apiCalls')` under a covered prefix — the route-coverage test fails a route metered twice. A route that genuinely must not be metered or checked needs a `QUOTA_EXCEPTIONS` entry with its reason in that service's `test/route-coverage.test.ts`; a new console-polling read belongs in `QUOTA_EXEMPT_ROUTES`. The generated route tables (`frontend/src/generated/route-table/*.json`) show each route's `quota: { metered, checked, exempt }`.

## Related

- [Billing Add-on Bundles](billing-bundles.md) — limits, pooling, the usage ledger
- [Error Handling](error-handling.md) — the `QUOTA_EXCEEDED` error code
- [Service Mesh](service-mesh.md) — the internal routes the quota service calls (and is called on)
