---
layout: default
title: DORA Metrics
image: /assets/og-image-solution.png
---

<!--
Copyright 2026 Pipeline Builder Contributors
SPDX-License-Identifier: Apache-2.0
-->

# DORA Metrics

The four DevOps Research and Assessment delivery-performance indicators, computed from real deploy-stage executions.

## Highlights

- **Deploy-basis only.** Every metric derives from real **deploy-stage** executions. A pipeline that only builds and tests produces **no** DORA data.
- **The panel starts empty and fills forward.** Deploy attribution comes from tags pipeline-core writes at synth time, so already-deployed pipelines emit nothing until they **re-synth**. That is expected, not a regression.
- **Lead time is measured, not proxied** — commit → deploy. It reports `unknown` rather than substituting a run-duration guess.
- **Lead time is off by default.** Commit resolution makes SCM calls in your AWS account, so it needs `setup-events --with-dora`.
- **Change failure rate is two-class**: deploy-time failures plus post-deploy failures, deduped so a deploy flagged by both an incident and a manual outcome counts once.
- **MTTR is production-only**, and **incidents take precedence** over manual outcomes when a deploy has both.
- **Coverage is the honesty check.** A high `withoutDeploys` means DORA is blind to most of your fleet.
- **Retention is split, tier-aware and bundle-extendable**, and the query window now tracks it — so you can't request a range past your own retention.

## Overview

This page is for platform teams and engineering leaders tracking delivery health. It covers how each metric is defined, the [performance-level](#performance-levels) bands, the [deploy tag standard](#declaring-deployments) that produces them, and the [endpoints](#endpoints).

DORA is an **advanced analytics** feature, gated behind the `advanced_reporting` entitlement — included on Enterprise, or the [Advanced Reporting add-on](billing-bundles.md) on other tiers — and the `reports:read` permission.

> **These metrics are DEPLOY-BASIS ONLY.** There is no run-based mode. This is a deliberate, **no-backward-compatibility** change: the old run-based frequency, the median-run-duration lead-time proxy, and the inferred CFR/MTTR are **removed**.
>
> **Historical pre-cutover data is excluded**, and there is no migration or backfill.

## How it works

1. **Declare** — a user sets an `environment` on each deploy stage. pipeline-core derives the `pb.deploys` tag (see [Declaring deployments](#declaring-deployments)).
2. **Ingest** — the events Lambda parses `pb.deploys`, sets `environment` on the deploy-stage events, resolves the source **commit range in-account** (oldest unshipped commit time plus count) — **only when enabled with `setup-events --with-dora`** — and forwards normalized events to the reporting service.
3. **Compute** — DORA is derived over the **deploy-stage** executions in the window: deployment frequency, two-class change-failure rate, measured lead time, production MTTR, and coverage.
4. **Classify** — each metric gets a `level` band (elite / high / medium / low, or `null` when there is no sample).
5. **Surface** — results render as per-environment **Reports**-page cards, with `production` as the headline, or are consumed via the [endpoints](#endpoints).

## Configuration

### 1. Set an `environment` on every deploy stage

This is what makes a stage a deployment at all. See [Declaring deployments](#declaring-deployments) for the tag standard it produces, and use the literal name **`production`** for the stage you want as the headline.

### 2. Re-synth the pipelines

Deploy attribution lives in synth-time tags, so an already-deployed pipeline contributes nothing until it re-synths and runs again. Watch `coverage.withoutDeploys` to see how much of the fleet is still dark.

### 3. Turn on lead time, if you want it

```bash
pipeline-manager infra setup-events --with-dora
```

Commit-timestamp resolution makes SCM calls and reads the org's `github-token` secret **in your AWS account**, so it is **off by default** and gated on the Lambda's `DORA_ENABLED` env var. It is only worthwhile for orgs holding the `advanced_reporting` add-on; re-run to toggle after a later purchase.

With it off, **standard reporting still works** and DORA lead time reports `unknown`.

### 4. Wire your incident tooling

Point PagerDuty, Datadog, Opsgenie or Alertmanager at the incident webhook to get an automated post-deploy CFR signal and a real MTTR, instead of marking deploys by hand. Full setup: [Incident webhook](incidents-webhook.md).

### 5. Tune the correlation window and retention

Both are per-org, self-serve from **Settings → Incident Reporting** (org-admin), or via `PUT /api/reports/settings/incidents`. See [Retention](#retention) for the two windows and their bounds.

## Declaring deployments

A **deployment** is a pipeline **stage** that ships to an environment. You declare it by setting an `environment` on the deploy stage; pipeline-core emits two CodePipeline tags the forwarder reads:

| Tag | Value |
|---|---|
| `pb.pipeline-id` | the platform `pipelineId` (the registry join key) |
| `pb.deploys` | `<stage>:<env>` pairs joined by `+`, e.g. `Deploy-stg-alias:staging+prod-wave:production` |

`<stage>` is the **CodePipeline stage name** — the stage's `alias`, or `<stageName>-alias` when it has none — because that is the name CodePipeline events report and the forwarder matches. A stage named `Deploy-prod` with no alias therefore appears as `Deploy-prod-alias`.

- The literal environment name **`production`** is the DORA **headline**: its card is the summary, and MTTR is measured production-only.
- A stage listed in `pb.deploys` is a deploy, and the forwarder sets `environment` only on those stages' events. A stage that is **absent** is not a deployment and never enters DORA.
- `isDeploy` is **not** a field — it is derived server-side as "`environment IS NOT NULL` on a STAGE event".

## How each metric is defined

All metrics are computed **per environment** over the deploy-stage executions in the window (deploy `completed_at` range). Cross-source time deltas are clamped ≥ 0.

### Deployment frequency

The count of **successful deploy-stage** executions for the environment. `perDay` = deployments ÷ window-days, where a window shorter than a day is treated as one day.

### Change failure rate

**Two-class**: `(deployTimeFailures + postDeployFailures) ÷ attempts`, as a percent.

| Component | Means |
|---|---|
| `deployTimeFailures` | Deploy stage `result=failed`, from events |
| `postDeployFailures` | A **successful** deploy later flagged as failed in production, from **either** a manual [outcome](#post-deploy-outcomes) **or** a correlated [incident webhook](#incidents-automated-post-deploy-failures). The two sources are **deduped by deploy execution** — a deploy flagged by both counts once |
| `attempts` | All terminal deploy-stage attempts (succeeded + failed) |

### Lead time

**MEASURED**: `median(deploy_completed − oldest_commit_time)` over successful deploys that carry a `commit_timestamp`, resolved in-account by the forwarder.

`medianSeconds` is **`null`, meaning unknown**, when no successful deploy in the environment carried a commit time. The median-run-duration proxy is **removed**.

### Mean time to restore (MTTR)

**Production-only**, from **both** sources:

- A webhook-ingested [incident](#incidents-automated-post-deploy-failures) contributes the **real** recovery time (`resolved_at − opened_at`).
- A manual [outcome](#post-deploy-outcomes) contributes `restored.at − deployed.completed_at`.

**Incidents take precedence** — when a deploy has both, the incident's recovery time is used.

`incidents` counts production deploys flagged failed; `restored` counts those that recovered; `medianSeconds` is `null` when no recovery is resolvable.

### Coverage

A reconciliation: `registered` pipelines from the registry versus `deploying`, meaning pipelines with at least one deploy-stage execution in-window. `withoutDeploys = registered − deploying`.

A high `withoutDeploys` means DORA is blind to most of the fleet — either pipelines not yet re-synthed with deploy tags, or pipelines that don't deploy.

## Performance levels

Each metric carries a `level` band (`elite` / `high` / `medium` / `low`, or `null` when there's no sample). Thresholds follow the DORA/Accelerate reports:

| Metric | Elite | High | Medium | Low |
|--------|-------|------|--------|-----|
| **Deployment Frequency** | ≥ 1/day | ≥ 1/week | ≥ 1/month | slower |
| **Change Failure Rate** | ≤ 5% | ≤ 10% | ≤ 15% | > 15% |
| **Mean Time To Restore** | < 1 hour | < 1 day | < 1 week | ≥ 1 week |
| **Lead Time** | < 1 day | < 1 week | < 1 month | ≥ 1 month |

The dashboard renders each band as a coloured badge; `null` bands show no badge.

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

Returns `data.trend` — deploy frequency plus **deploy-time** change-failure rate, bucketed by `interval` on the deploy `completed_at`. Same guards, rollup and optional scoping (`pipelineId` / `environment`) as `/dora`. Each point:

```json
{ "period": "2026-07-01T00:00:00.000Z", "deployments": 4, "failed": 1, "total": 5, "changeFailurePct": 20 }
```

### Post-deploy outcomes

```
POST /api/reports/deployments/:executionId/outcome
```

Body: `{ "outcome": "failed" | "restored", "at": "<iso>", "environment": "<name>?" }`.

Marks a deployment failed (a production incident linked to the deploy) or restored, feeding the **post-deploy** CFR component and **real MTTR**.

Requires `pipelines:write` — it is a write, and `reports:read` only views. `advanced_reporting`-gated, org-scoped, and idempotent: re-posting the same `(execution, outcome)` refreshes `at` instead of double-counting.

### Ingest health

```
POST /api/reports/ingest-health
GET  /api/reports/ingest-health
```

Body: `{ "forwarded": <int>, "dropped": <int>, "lastEventAt": "<iso>" }`. Posted by the AWS events Lambda, using a `reporting:ingest`-scoped service-account key it exchanges per batch, with the org taken from the token identity, so the Reports UI can show flowing / stale / dropping. One row per org.

The `GET` is the user-facing read behind the Reports freshness strip — org-scoped, `reports:read`, not the machine scope and not `advanced_reporting`. It returns `{ health, now }`, where `health` is `null` when the org has **never** been reported on, which the UI states plainly rather than calling it stale.

Note the heartbeat is only posted *after* the forwarder forwards something, so a stale heartbeat means "no events have arrived since X" — and the UI says exactly that rather than guessing between an idle account and a broken forwarder.

### Prometheus metrics

On ingest, the reporting service increments the following on its `/metrics`, scraped by in-cluster Prometheus:

- `pipeline_stage_result_total{pipeline_id,stage,environment,org_id,result}`
- `pipeline_deploy_result_total{environment,org_id,result}` — a subset, only stage events that carry a deploy `environment`.

`result` is `succeeded` or `failed`.

### Incidents (automated post-deploy failures)

```
POST /api/reports/incidents
```

Body: `{ "incidentId", "environment", "openedAt", "resolvedAt"?, "severity" }`. Posted by your incident tooling (PagerDuty / Datadog / Alertmanager) using the machine `reporting:ingest` scope — the same credential the event forwarder holds — with the org taken from the token identity.

**Idempotent** on `(org, incidentId)`: a later resolve re-post updates `resolvedAt`. Each incident is **correlated** to the most recent successful deploy to its `environment` with `completed_at ≤ openedAt` within `DORA_INCIDENT_WINDOW_HOURS` (default 24, **overridable per-org**), producing an **automated** post-deploy CFR signal and a **real** MTTR.

Companion routes, all `advanced_reporting`-gated:

| Route | Purpose |
|---|---|
| `POST /api/reports/incidents/alertmanager` | Native Alertmanager adapter — reshapes the batched webhook payload into one incident per alert; same `reporting:ingest` auth |
| `GET` / `PUT /api/reports/settings/incidents` | Read or set the per-org correlation window **and** the two [retention](#retention) windows. PUT needs org-admin `org:settings`; send any subset, omitted fields unchanged |
| `POST /api/reports/incidents/test` | Non-persisting wiring dry-run — does a synthetic incident correlate now? |
| `GET /api/reports/incidents` | Recent incidents with correlation and resolved state, paginated |

Configured self-serve from **Settings → Incident Reporting** (org-admin). See [Incident webhook](incidents-webhook.md) for the full contract, payload, provider setup, token issuance and admin UI.

### Build health

```
GET /api/reports/execution/build-health?pipelineId=<id>&from=<iso>&to=<iso>
```

Per-pipeline **build health**: per-stage run counts, success rate, and duration percentiles (`p50Ms` / `p90Ms` / `p99Ms`) rolled up per stage from the pipeline's STAGE events.

Requires only `reports:read` — this is **standard reporting, available on every tier**, and is NOT `advanced_reporting`-gated. `pipelineId` is required.

Returns `data.buildHealth` = `{ stages: [{ stage, runs, successes, failures, successRate, p50Ms, p90Ms, p99Ms }], totals: { runs, failures, failureRate } }`, with totals summed across stages. Rendered on the Reports page as a **Build Health** sub-panel next to the DORA panel, keyed by the scoped pipeline.

## Retention

Reporting rows do not live forever. A leader-locked background sweep in the reporting service hard-deletes expired rows by `created_at` on a **split** schedule, so high-volume standard events expire faster than the low-volume DORA source. Both windows are **per-org overridable**; unset falls back to a global env default.

| Window | Covers | Default | Env default | Per-org override |
|--------|--------|---------|-------------|------------------|
| **Standard events** | `pipeline_events` with `environment IS NULL` (non-deploy STAGE/ACTION/build activity) | **30 days** | `REPORTING_EVENT_RETENTION_DAYS` | `dora_settings.event_retention_days` |
| **DORA source** | `pipeline_events` with `environment IS NOT NULL` (deploy stages) + all `deployment_outcomes` + all `incidents` | **180 days** | `REPORTING_DORA_RETENTION_DAYS` | `dora_settings.dora_retention_days` |

**Retention is tier-aware and bundle-extendable.** Each tier carries a baseline window that seeds these two values: paid tiers default to 30 days (standard events) and 180 days (DORA source), while the **unlimited** tier is **unlimited retention** (the `-1` sentinel) — the sweep **skips the org entirely** and keeps all history forever.

Effective retention = tier baseline + Σ(add-on pack grant), so the **[Standard Retention Pack](billing-bundles.md)** adds +90 standard-event days and the **DORA History Pack** adds +365 DORA-source days on top of the baseline. Billing computes that effective window and syncs it into `dora_settings`; a manual admin override writes the same columns, last-writer-wins.

**Setting an override.** Self-serve from **Settings → Incident Reporting → Retention** (org-admin, `advanced_reporting`), or via `PUT /api/reports/settings/incidents`. Bounds are **1–730 days**, or the `-1` unlimited sentinel from the unlimited tier.

**The report-query window tracks per-org retention.** The old flat 365-day query cap is replaced by a per-org effective cap of `min(730, orgRetentionDays)`: DORA/CFR/MTTR routes cap by the **DORA** window, standard-event routes cap by the **standard-event** window. So a base org can't request a range past its retention — which would be empty anyway — while a **DORA History Pack** org can query the full extended range. The **absolute ceiling stays 730 days**, and an unlimited-tier (`-1`) org queries right up to it. System-admin cross-org report routes keep the flat 730-day ceiling and are not per-org capped.

**Never purged:** `ingest_health` and `dora_settings`, both bounded at one row per org.

**Sweep tuning.** Cadence and batching are env-tuned (`REPORTING_RETENTION_INTERVAL_HOURS`, `REPORTING_RETENTION_BATCH_SIZE`, …); disable entirely with `REPORTING_RETENTION_ENABLED=false`. The sweep only runs when the reporting service is running, and — with Redis configured — only on the pod holding the leader lock.

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
| `*.level` | [Performance band](#performance-levels): `elite` / `high` / `medium` / `low`, or `null` |

## Related

- [Incident webhook](incidents-webhook.md) — automated post-deploy CFR and real MTTR from your incident tooling
- [API Reference](api-reference.md) — full reporting endpoint list
- [AWS Deployment — Report API Endpoints](aws-deployment.md#report-api-endpoints)
- [Roles & Permissions](permissions.md) — `reports:read` and `reports:rollup`
- [Billing Add-on Bundles](billing-bundles.md) — how tier feature entitlements such as `advanced_reporting` work
- [Stakeholder Reports](stakeholder-reports.md) — the scheduled, manager-facing reports these metrics feed
