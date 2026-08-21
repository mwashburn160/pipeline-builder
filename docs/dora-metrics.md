---
layout: default
title: DORA Metrics
image: /assets/og-image-solution.png
---

# DORA Metrics

## Overview

This document explains Pipeline Builder's **DORA metrics** — the four DevOps Research and Assessment delivery-performance indicators — covering how each is defined, the [performance-level](#performance-levels) bands, the [deploy tag standard](#declaring-deployments) that produces them, and the [endpoints](#endpoints). It's for platform teams and engineering leaders tracking delivery health. DORA is an **advanced analytics** feature gated behind the `advanced_reporting` entitlement (included on Enterprise, or the [Advanced Reporting add-on](billing-bundles.md) on other tiers) and the `reports:read` permission.

> **These metrics are DEPLOY-BASIS ONLY.** Every metric derives from real
> **deploy-stage** executions — there is no run-based mode. A pipeline that only
> builds/tests (no deploy stage) produces **no** DORA data. This is a deliberate,
> **no-backward-compatibility** change: the old run-based frequency, the
> median-run-duration lead-time proxy, and the inferred CFR/MTTR are **removed**.

> **The panel is empty until pipelines re-synth.** Deploy attribution comes from
> tags that pipeline-core writes at synth time. Already-deployed pipelines emit
> no DORA data until they **re-synth** with the new deploy tags and run again —
> the panel starts empty and fills forward. That is expected, not a regression.
> Historical pre-cutover data is excluded; there is no migration or backfill.

## Process overview

1. **Declare** — a user sets an `environment` on each deploy stage. pipeline-core derives the `pb.deploys` tag (see [Declaring deployments](#declaring-deployments)).
2. **Ingest** — the events Lambda parses `pb.deploys`, sets `environment` on the deploy-stage events, resolves the source **commit range in-account** (oldest unshipped commit time + count) — **only when enabled with `setup-events --with-dora`** (the commit enrichment is an add-on cost; see below) — and forwards normalized events to the reporting service.

> **Enabling lead time (`--with-dora`).** Commit-timestamp resolution makes SCM calls and reads the org's `github-token` secret in your AWS account, so it's **off by default** and gated on the Lambda's `DORA_ENABLED` env var. Turn it on with `pipeline-manager infra setup-events --with-dora` (only worthwhile for orgs holding the `advanced_reporting` add-on; re-run to toggle after a later purchase). With it off, **standard reporting still works** and DORA lead time reports `unknown`.
3. **Compute** — DORA is derived over the **deploy-stage** executions in the window: deployment frequency, two-class change-failure rate, measured lead time, production MTTR, and coverage.
4. **Classify** — each metric gets a `level` band (elite/high/medium/low, or `null` when there's no sample).
5. **Surface** — results render as per-environment **Reports**-page cards (headline `production`), or are consumed via the endpoints.

## Declaring deployments

A **deployment** is a pipeline **stage** that ships to an environment. You declare
it by setting an `environment` on the deploy stage; pipeline-core emits two
CodePipeline tags the forwarder reads:

| Tag | Value |
|---|---|
| `pb.pipeline-id` | the platform `pipelineId` (the registry join key) |
| `pb.deploys` | `<stage>:<env>` pairs joined by `+`, e.g. `Deploy-stg:staging+Deploy-prod:production` |

- The literal environment name **`production`** is the DORA **headline** — its card is the summary, and MTTR is measured production-only.
- A stage listed in `pb.deploys` is a deploy; the forwarder sets `environment` only on those stages' events. A stage that is **absent** is not a deployment and never enters DORA.
- `isDeploy` is **not** a field — it is derived server-side as “`environment IS NOT NULL` on a STAGE event”.

## How each metric is defined

All metrics are computed **per environment** over the deploy-stage executions in
the window (deploy `completed_at` range). Cross-source time deltas are clamped ≥0.

- **Deployment Frequency** — the count of **successful deploy-stage** executions for the environment. `perDay` = deployments ÷ window-days (a window shorter than a day is treated as one day).
- **Change Failure Rate** — **two-class**: `(deployTimeFailures + postDeployFailures) ÷ attempts`, as a percent.
  - `deployTimeFailures` — deploy stage `result=failed` (from events).
  - `postDeployFailures` — a **successful** deploy later flagged as failed in production, from **either** a manual [outcome](#post-deploy-outcomes) **or** a correlated [incident webhook](#incidents-automated-post-deploy-failures). The two sources are **deduped by deploy execution** — a deploy flagged by both counts once.
  - `attempts` — all terminal deploy-stage attempts (succeeded + failed).
- **Lead Time** — **MEASURED**: `median(deploy_completed − oldest_commit_time)` over successful deploys that carry a `commit_timestamp` (resolved in-account by the forwarder). `medianSeconds` is **`null` (= unknown)** when no successful deploy in the environment carried a commit time. The median-run-duration proxy is **removed**.
- **Mean Time To Restore (MTTR)** — **production-only**, from **both** sources: a webhook-ingested [incident](#incidents-automated-post-deploy-failures) contributes the **real** recovery time (`resolved_at − opened_at`), and a manual [outcome](#post-deploy-outcomes) contributes `restored.at − deployed.completed_at`. **Incidents take precedence** — when a deploy has both, the incident's recovery time is used. `incidents` counts production deploys flagged failed; `restored` counts those that recovered; `medianSeconds` is `null` when no recovery is resolvable.
- **Coverage** — reconciliation: `registered` pipelines (from the registry) vs `deploying` (pipelines with ≥1 deploy-stage execution in-window); `withoutDeploys = registered − deploying`. A high `withoutDeploys` means DORA is blind to most of the fleet (pipelines not yet re-synthed with deploy tags, or that don't deploy).

## Performance levels

Each metric carries a `level` band (`elite` / `high` / `medium` / `low`, or `null`
when there's no sample). Thresholds follow the DORA/Accelerate reports:

| Metric | Elite | High | Medium | Low |
|--------|-------|------|--------|-----|
| **Deployment Frequency** | ≥ 1/day | ≥ 1/week | ≥ 1/month | slower |
| **Change Failure Rate** | ≤ 5% | ≤ 10% | ≤ 15% | > 15% |
| **Mean Time To Restore** | < 1 hour | < 1 day | < 1 week | ≥ 1 week |
| **Lead Time** | < 1 day | < 1 week | < 1 month | ≥ 1 month |

The dashboard renders each band as a colored badge; `null` bands show no badge.

---

## Endpoints

### DORA metrics

```
GET /api/reports/execution/dora?from=<iso>&to=<iso>&includeDescendants=<bool>
```

Requires the `reports:read` permission **and** the `advanced_reporting` feature.

| Param | Values | Default | Notes |
|-------|--------|---------|-------|
| `from` | ISO 8601 timestamp | 30 days ago | Start of the window |
| `to` | ISO 8601 timestamp | now | End of the window |
| `includeDescendants` | `true`, `false` | `false` | Roll the aggregate over the org → team subtree. **Requires `reports:rollup`**; ignored otherwise. |
| `pipelineId` | pipeline id | — | Restrict to a single pipeline (per-pipeline DORA). |
| `environment` | environment name | — | Restrict to a single deploy environment. |

The window is capped at the org's effective **DORA retention** (`min(730, doraRetentionDays)`, absolute ceiling **730 days**) — a wider range returns **HTTP 400**. See [Retention](#retention).

### DORA trend

```
GET /api/reports/execution/dora/trend?interval=<day|week|month>&from=<iso>&to=<iso>
```

Returns `data.trend` — deploy frequency + **deploy-time** change-failure rate,
bucketed by `interval` on the deploy `completed_at`. Same guards, rollup, and
optional scoping (`pipelineId`/`environment`) as `/dora`. Each point:

```json
{ "period": "2026-07-01T00:00:00.000Z", "deployments": 4, "failed": 1, "total": 5, "changeFailurePct": 20 }
```

### Post-deploy outcomes

```
POST /api/reports/deployments/:executionId/outcome
```

Body `{ "outcome": "failed" | "restored", "at": "<iso>", "environment": "<name>?" }`.
Marks a deployment failed (a production incident linked to the deploy) or restored.
Feeds the **post-deploy** CFR component and **real MTTR**. `advanced_reporting`-gated,
org-scoped, and idempotent — re-posting the same `(execution, outcome)` refreshes
`at` instead of double-counting.

### Ingest health

```
POST /api/reports/ingest-health
```

Body `{ "forwarded": <int>, "dropped": <int>, "lastEventAt": "<iso>" }`. Posted by
the AWS events Lambda (machine `reporting:ingest` scope; org taken from the token
identity) so the Reports UI can show flowing / stale / dropping. One row per org.

### Prometheus metrics

On ingest, the reporting service increments (exposed on its `/metrics`, scraped by
in-cluster Prometheus):

- `pipeline_stage_result_total{pipeline_id,stage,environment,org_id,result}`
- `pipeline_deploy_result_total{environment,org_id,result}` — a subset, only stage events that carry a deploy `environment`.

`result` is `succeeded` | `failed`.

### Incidents (automated post-deploy failures)

```
POST /api/reports/incidents
```

Body `{ "incidentId", "environment", "openedAt", "resolvedAt"?, "severity" }`. Posted
by your incident tooling (PagerDuty / Datadog / Alertmanager) using the machine
`reporting:ingest` scope — the same credential the event forwarder holds; the org
is taken from the token identity. **Idempotent** on `(org, incidentId)` — a later
resolve re-post updates `resolvedAt`. Each incident is **correlated** to the most
recent successful deploy to its `environment` with `completed_at ≤ openedAt` within
`DORA_INCIDENT_WINDOW_HOURS` (default 24, **overridable per-org**), producing an
**automated** post-deploy CFR signal + a **real** MTTR.

Companion routes (all `advanced_reporting`-gated):

- `POST /api/reports/incidents/alertmanager` — **native Alertmanager adapter** (reshapes the batched webhook payload into one incident per alert; same `reporting:ingest` auth).
- `GET/PUT /api/reports/settings/incidents` — read/set the **per-org correlation window** override **and the two [retention](#retention) windows** (PUT needs org-admin `org:settings`; send any subset — omitted fields are left unchanged).
- `POST /api/reports/incidents/test` — non-persisting wiring dry-run (does a synthetic incident correlate now?).
- `GET /api/reports/incidents` — recent incidents + correlation + resolved state, paginated.

Configured self-serve from **Settings → Incident Reporting** (org-admin). See
**[Incident webhook](incidents-webhook.md)** for the full contract, payload,
provider setup, token issuance, and the admin UI.

### Build health

```
GET /api/reports/execution/build-health?pipelineId=<id>&from=<iso>&to=<iso>
```

Per-pipeline **build health** — per-stage run counts, success rate, and duration
percentiles (`p50Ms`/`p90Ms`/`p99Ms`) rolled up per stage from the pipeline's STAGE
events. Requires only `reports:read` — it is **standard reporting, available on
every tier** (NOT `advanced_reporting`-gated). `pipelineId` is required. Returns
`data.buildHealth` = `{ stages: [{ stage, runs, successes, failures, successRate,
p50Ms, p90Ms, p99Ms }], totals: { runs, failures, failureRate } }` (totals sum
across stages). Rendered on the Reports page as a **Build Health** sub-panel next
to the DORA panel, keyed by the scoped pipeline.

---

## Retention

Reporting rows do not live forever — a leader-locked background sweep in the
reporting service hard-deletes expired rows by `created_at` on a **split**
schedule, so high-volume standard events expire faster than the low-volume DORA
source. Both windows are **per-org overridable**; unset falls back to a global
env default.

| Window | Covers | Default | Env default | Per-org override |
|--------|--------|---------|-------------|------------------|
| **Standard events** | `pipeline_events` with `environment IS NULL` (non-deploy STAGE/ACTION/build activity) | **30 days** | `REPORTING_EVENT_RETENTION_DAYS` | `dora_settings.event_retention_days` |
| **DORA source** | `pipeline_events` with `environment IS NOT NULL` (deploy stages) + all `deployment_outcomes` + all `incidents` | **180 days** | `REPORTING_DORA_RETENTION_DAYS` | `dora_settings.dora_retention_days` |

- **Retention is tier-aware and bundle-extendable.** Each tier carries a baseline
  window that seeds these two values: paid tiers default to **30 days** (standard
  events) / **180 days** (DORA source), while the **unlimited** tier is **unlimited
  retention** (`-1` sentinel) — the sweep **skips the org entirely** and keeps all
  history forever. Effective retention = tier baseline + Σ(add-on pack grant), so
  the **[Standard Retention Pack](billing-bundles.md)** adds +90 standard-event days
  and the **DORA History Pack** adds +365 DORA-source days on top of the baseline.
  Billing computes that effective window and syncs it into `dora_settings`; a manual
  admin override (below) writes the same columns (last-writer-wins).
- Overrides are set self-serve from **Settings → Incident Reporting → Retention**
  (org-admin, `advanced_reporting`) or via `PUT /api/reports/settings/incidents`.
  Bounds are **1–730 days** (or the `-1` unlimited sentinel from the unlimited tier).
- **The report-query window now tracks per-org retention.** The old flat 365-day
  query cap is replaced by a per-org effective cap of `min(730, orgRetentionDays)` —
  DORA/CFR/MTTR routes cap by the **DORA** window, standard-event routes cap by the
  **standard-event** window. So a base org can't request a range past its retention
  (which would be empty anyway), while a **DORA History Pack** org can query the full
  extended range. The **absolute ceiling stays 730 days**, and an unlimited-tier
  (`-1`) org queries right up to that ceiling. System-admin cross-org report routes
  keep the flat 730-day ceiling (they are not per-org capped).
- **`ingest_health` and `dora_settings` are never purged** (bounded, one row per org).
- Sweep cadence + batching are env-tuned (`REPORTING_RETENTION_INTERVAL_HOURS`,
  `REPORTING_RETENTION_BATCH_SIZE`, …); disable entirely with
  `REPORTING_RETENTION_ENABLED=false`. The sweep only runs when the reporting
  service is running (and, with Redis configured, on the pod holding the leader lock).

---

## Response

`data.dora` has the following shape:

```json
{
  "data": {
    "dora": {
      "window": { "from": "2026-06-27T00:00:00.000Z", "to": "2026-07-27T00:00:00.000Z" },
      "filters": { "pipelineId": null, "environment": null },
      "headline": "production",
      "environments": [
        {
          "environment": "production",
          "deploymentFrequency": { "deployments": 128, "perDay": 4.27, "level": "elite" },
          "changeFailureRate": { "rate": 7.9, "deployTimeFailures": 8, "postDeployFailures": 3, "attempts": 139, "level": "high" },
          "leadTime": { "deployments": 120, "medianSeconds": 5400, "level": "high" }
        }
      ],
      "meanTimeToRestore": { "incidents": 4, "restored": 3, "medianSeconds": 1840, "level": "high" },
      "coverage": { "registered": 20, "deploying": 12, "withoutDeploys": 8 }
    }
  }
}
```

| Field | Meaning |
|-------|---------|
| `window.from` / `window.to` | The resolved reporting window (deploy `completed_at` range) |
| `filters.pipelineId` / `filters.environment` | The scoping applied (echoed), or `null` |
| `headline` | The headline environment name (`production`) |
| `environments[]` | Per-environment cards (headline first, then A→Z) |
| `environments[].deploymentFrequency` | `deployments` (successful deploys), `perDay`, `level` |
| `environments[].changeFailureRate` | Two-class: `rate`, `deployTimeFailures`, `postDeployFailures`, `attempts`, `level` |
| `environments[].leadTime` | `deployments` (median sample), `medianSeconds` (`null` = unknown), `level` |
| `meanTimeToRestore` | Production-only: `incidents`, `restored`, `medianSeconds` (`null` when none), `level` |
| `coverage` | `registered`, `deploying`, `withoutDeploys` |
| `*.level` | [Performance band](#performance-levels): `elite`/`high`/`medium`/`low`, or `null` |

---

## Related

- [Incident webhook](incidents-webhook.md) — automated post-deploy CFR + real MTTR from your incident tooling
- [API Reference](api-reference.md) — full reporting endpoint list
- [AWS Deployment — Report API Endpoints](aws-deployment.md#report-api-endpoints)
- [Roles & Permissions](permissions.md) — `reports:read` and `reports:rollup`
- [Billing Add-on Bundles](billing-bundles.md) — how tier feature entitlements (like `advanced_reporting`) work
