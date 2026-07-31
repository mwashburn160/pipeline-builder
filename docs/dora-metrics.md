---
layout: default
title: DORA Metrics
image: /assets/og-image-solution.png
---

# DORA Metrics

## Overview

This document explains Pipeline Builder's **DORA metrics** — the four DevOps Research and Assessment delivery-performance indicators — covering how each is defined, the [performance-level](#performance-levels) bands, the [run-based vs deploy-based](#deploy-based-vs-run-based) distinction, and the two read-only [endpoints](#endpoints) plus their response shape. It's for platform teams and engineering leaders tracking delivery health. DORA is an **advanced analytics** feature gated behind the `advanced_reporting` entitlement (included on Enterprise, or the [Advanced Reporting add-on](billing-bundles.md) on other tiers) and the `reports:read` permission.

## Process overview

1. **Ingest** — CodePipeline/CodeBuild state changes flow into the reporting service via EventBridge; deploy metadata (`environment`, `commit_sha`, `commit_ref`) is captured when the event carries it.
2. **Select** — the query resolves a window (default last 30 days, capped at 365) and optional scoping (`pipelineId`, `environment`/`deploysOnly`, `includeDescendants`).
3. **Compute** — DORA is derived over the **terminal** executions in the window: deployment frequency, change-failure rate, per-incident MTTR, and a lead-time proxy.
4. **Classify** — each metric gets a `level` band (elite/high/medium/low), and the response reports its `basis` (`run` vs `deploy`).
5. **Surface** — results render as four **Reports**-page cards (with a deployment-frequency trend sparkline) or are consumed via the `/dora` and `/dora/trend` endpoints.

The four **DORA metrics** (from the DevOps Research and Assessment program) are the
industry-standard indicators of software delivery performance. Pipeline Builder derives them
from the pipeline execution events already flowing through the reporting service (EventBridge
ingestion), so you get delivery-performance signal without wiring up anything new.

| Metric | What it tells you |
|--------|-------------------|
| **Deployment Frequency** | How often you ship |
| **Change Failure Rate** | How often a deploy fails |
| **Mean Time To Restore (MTTR)** | How quickly you recover from a failed deploy |
| **Lead Time** | How long a change takes to reach production (see the [caveat](#lead-time-caveat--roadmap)) |

The metrics are surfaced on the dashboard **Reports** page as four cards (with a
[performance-level](#performance-levels) badge and a deployment-frequency trend sparkline), and
served from two endpoints for automation. Each metric carries a `level` band and the response
reports its [`basis`](#deploy-based-vs-run-based) — whether the numbers count real deployments or
pipeline runs.

> **Availability:** DORA is an **advanced analytics** feature, gated behind the
> `advanced_reporting` entitlement. It is **included on the Enterprise tier** and available as a
> purchasable **[Advanced Reporting add-on bundle](billing-bundles.md)** on every other tier
> (Developer, Pro, Team). The endpoints additionally require the `reports:read` permission. See
> [Deploy-based vs run-based](#deploy-based-vs-run-based) below for the accuracy caveat.

> **By default these metrics are run-based.** Unless you scope the query to a deploy
> [`environment`](#deploy-based-vs-run-based), a "deployment" is a **successful pipeline run**, not
> a verified production deployment — an untagged CI-only build/test pipeline counts the same as one
> that ships to prod. Read Deployment Frequency as pipeline throughput, Change Failure Rate as a
> **pipeline**-failure rate (failures caught in CI count too), and MTTR as pipeline-recovery time.
> The response `basis` field is `"run"` in this mode. To count real deployments, tag pipelines with
> an environment and pass `environment=`/`deploysOnly=true` (`basis: "deploy"`).

---

## How each metric is defined

Pipeline Builder computes DORA over the **terminal** pipeline executions in the selected window.
A "deployment" is **one successful pipeline execution** (see the run-based note above). The exact
definitions:

- **Deployment Frequency** — the count of **SUCCEEDED** terminal pipeline executions in the
  window. `perDay` = deployments ÷ window-days (a window shorter than a day is treated as one day).
- **Change Failure Rate** — `failed ÷ (succeeded + failed)` terminal executions, expressed as a
  percent. Canceled and stopped executions are **excluded** from the denominator.
- **Mean Time To Restore (MTTR)** — measured per **incident**: consecutive failed runs of a
  pipeline (with no successful run between them) collapse into **one incident**, and the gap is
  measured from the **first failure's end** to the **recovering run's end**. To avoid
  right-censoring, the recovery is looked up up to **30 days past** the window's `to` bound, so a
  failure near the edge isn't miscounted as unrecovered. `avgSeconds` is `null` when there were no
  incidents; `restored` counts incidents that recovered.
- **Lead Time** — an **approximation** (`approx: true`). See the caveat below.

### Lead Time caveat / roadmap

> **Lead Time is an approximation, not true commit→production lead time.**
>
> Pipeline Builder reports lead time as the **median successful pipeline run time**
> (pipeline start → deploy complete), and flags it with `approx: true`. Executions do **not**
> yet capture the source **commit time**, so true "time from code committed to code running in
> production" cannot be measured today. True commit→production lead time is a **roadmap item**.
> Treat the reported `leadTime.medianSeconds` as a run-duration proxy only.

`leadTime.medianSeconds` is `null` when there were no successful deployments in the window.

---

## Performance levels

Each metric carries a `level` band (`elite` / `high` / `medium` / `low`, or `null` when there's no
sample to classify — e.g. an empty window). Thresholds follow the DORA/Accelerate reports:

| Metric | Elite | High | Medium | Low |
|--------|-------|------|--------|-----|
| **Deployment Frequency** | ≥ 1/day | ≥ 1/week | ≥ 1/month | slower |
| **Change Failure Rate** | ≤ 5% | ≤ 10% | ≤ 15% | > 15% |
| **Mean Time To Restore** | < 1 hour | < 1 day | < 1 week | ≥ 1 week |
| **Lead Time** (proxy) | < 1 day | < 1 week | < 1 month | ≥ 1 month |

The dashboard renders each band as a colored badge; `null` bands show no badge.

## Deploy-based vs run-based

The response `basis` reports what the numbers count:

- **`"run"`** (default) — every successful terminal pipeline execution is a "deployment". No deploy
  marker is applied, so DF/CFR/MTTR reflect **pipeline activity**, not verified deployments.
- **`"deploy"`** — the query is scoped to executions tagged with a deploy **`environment`**, so the
  numbers count **real deployments**. Enable it with `environment=<name>` (one target) or
  `deploysOnly=true` (any environment).

Deploy attribution comes from event metadata captured at ingest into three nullable
`pipeline_events` columns — `environment`, `commit_sha`, `commit_ref`:

- **`environment`** is set from an `Environment` tag on the pipeline. Synthesize a pipeline with the
  `PipelineBuilder` construct's optional `environment` prop (or add the `Environment` tag) and the
  events Lambda forwards it — from then on that pipeline's executions are deploy-attributed.
- **`commit_sha` / `commit_ref`** capture the source revision when the CodePipeline event carries it
  (most reliably on source-action events). These lay the groundwork for true lead time; see the
  [caveat](#lead-time-caveat--roadmap). Legacy/untagged events leave all three `NULL` and fall back
  to run-based.

---

## Endpoints

### DORA metrics

```
GET /api/reports/execution/dora?from=<iso>&to=<iso>&includeDescendants=<bool>
```

Requires the `reports:read` permission **and** the `advanced_reporting` feature (included on Enterprise, or via the [Advanced Reporting add-on](billing-bundles.md) on other tiers).

### Query parameters

| Param | Values | Default | Notes |
|-------|--------|---------|-------|
| `from` | ISO 8601 timestamp | 30 days ago | Start of the window |
| `to` | ISO 8601 timestamp | now | End of the window |
| `includeDescendants` | `true`, `false` | `false` | Roll the aggregate over the org → team subtree. **Requires `reports:rollup`** (same gate as the other execution reports); ignored for callers without it. |
| `pipelineId` | pipeline id | — | Restrict to a single pipeline (per-pipeline DORA). |
| `environment` | environment name | — | Count only executions deployed to this target (`basis: "deploy"`). |
| `deploysOnly` | `true`, `false` | `false` | Count only executions tagged with **any** environment (`basis: "deploy"`). |

The window is capped at **365 days** — a wider `from`/`to` range returns **HTTP 400**.

### DORA trend

```
GET /api/reports/execution/dora/trend?interval=<day|week|month>&from=<iso>&to=<iso>
```

Returns `data.trend` — deployment frequency + change-failure rate bucketed by `interval` for a
sparkline. Same guards, rollup, and optional scoping (`pipelineId`/`environment`/`deploysOnly`) as
`/dora`. Each point:

```json
{ "period": "2026-07-01T00:00:00.000Z", "deployments": 4, "failed": 1, "total": 5, "changeFailurePct": 20 }
```

### Rollup behavior

With `includeDescendants=true`, the aggregate is computed over the parent org and all of its
descendant teams (the org → team subtree). This is gated by **`reports:rollup`**, exactly like the
other execution reports; a caller holding only `reports:read` always sees just their own org's
executions.

---

## Response

`data.dora` has the following shape:

```json
{
  "data": {
    "dora": {
      "window": { "from": "2026-06-27T00:00:00.000Z", "to": "2026-07-27T00:00:00.000Z" },
      "basis": "run",
      "filters": { "pipelineId": null, "environment": null },
      "deploymentFrequency": { "deployments": 128, "perDay": 4.27, "level": "elite" },
      "changeFailureRate": { "failed": 11, "total": 139, "pct": 7.91, "level": "high" },
      "meanTimeToRestore": { "failures": 11, "restored": 10, "avgSeconds": 1840, "level": "high" },
      "leadTime": { "deployments": 128, "medianSeconds": 512, "approx": true, "level": "elite" }
    }
  }
}
```

| Field | Meaning |
|-------|---------|
| `window.from` / `window.to` | The resolved reporting window |
| `basis` | `"run"` (default) or `"deploy"` — see [Deploy-based vs run-based](#deploy-based-vs-run-based) |
| `filters.pipelineId` / `filters.environment` | The scoping applied (echoed), or `null` |
| `deploymentFrequency.deployments` | SUCCEEDED terminal executions in the window |
| `deploymentFrequency.perDay` | Deployments ÷ window-days |
| `changeFailureRate.failed` | FAILED terminal executions |
| `changeFailureRate.total` | SUCCEEDED + FAILED (canceled/stopped excluded) |
| `changeFailureRate.pct` | `failed ÷ total`, as a percent |
| `meanTimeToRestore.failures` | Failure **incidents** in the window (consecutive failures collapsed) |
| `meanTimeToRestore.restored` | Incidents that recovered (next same-pipeline success, up to 30 days past `to`) |
| `meanTimeToRestore.avgSeconds` | Average restore time in seconds (incident-end → recovery-end), or `null` when no incidents |
| `leadTime.deployments` | Successful deployments the median is drawn from |
| `leadTime.medianSeconds` | Median successful **run time** (proxy — see caveat), or `null` |
| `leadTime.approx` | Always `true` — signals the lead-time approximation |
| `*.level` | [Performance band](#performance-levels): `elite`/`high`/`medium`/`low`, or `null` |

---

## Related

- [API Reference](api-reference.md) — full reporting endpoint list
- [AWS Deployment — Report API Endpoints](aws-deployment.md#report-api-endpoints)
- [Roles & Permissions](permissions.md) — `reports:read` and `reports:rollup`
- [Billing Add-on Bundles](billing-bundles.md) — how tier feature entitlements (like `advanced_reporting`) work
