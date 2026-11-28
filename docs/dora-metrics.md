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
- **The panel starts empty and fills forward.** Deploy attribution comes from tags pipeline-core writes at synth time, so a pipeline contributes only after it is synthesized with an `environment` on its deploy stage and runs.
- **Lead time is measured, not proxied** — commit → deploy. It reports `unknown` rather than substituting a run-duration guess.
- **Lead time is off by default.** Commit resolution makes SCM calls in your AWS account, so it needs `setup-events --with-dora`.
- **Change failure rate is two-class**: deploy-time failures plus post-deploy failures, deduped so a deploy flagged by both an incident and a manual outcome counts once.
- **Post-deploy failures are anchored to their deploy**: they count in the window (and trend bucket) the deploy completed in, whenever they were flagged.
- **Time to restore is a median, measured from the failure.** It is production-only, and **incidents take precedence** over manual outcomes when a deploy has both. (The API field keeps its historical name, `meanTimeToRestore`.)
- **No band without a sample.** Fewer than 5 deployments (frequency, CFR) or 5 measurements (lead time, time to restore) reads `insufficient` — "Not enough data (n = X)" — rather than elite or low.
- **Coverage is the honesty check.** A high `withoutDeploys` means DORA is blind to most of your fleet.
- **Retention is split, tier-aware and bundle-extendable**, and the query window tracks it — so you can't request a range past your own retention.

## Overview

This page is for platform teams and engineering leaders tracking delivery health. It covers how each metric is defined, the [performance-level](#performance-levels) bands, the [deploy tag standard](#declaring-deployments) that produces them, and the [endpoints](#endpoints).

DORA is an **advanced analytics** feature, gated behind the `advanced_reporting` entitlement — included on Business, Enterprise and Unlimited, or the [Advanced Reporting add-on](billing-bundles.md) on Developer, Pro and Team — and the `reports:read` permission. (Stakeholder Reports, `stakeholder_reports`, is a separate entitlement: included on Enterprise and Unlimited, an add-on on Pro, Team and Business.)

> **These metrics are DEPLOY-BASIS ONLY.** There is no run-based mode: frequency, lead time, CFR and time-to-restore are all computed from deploy rows.

## How it works

1. **Declare** — a user sets an `environment` on each deploy stage. pipeline-core derives the `pb.deploys` tag (see [Declaring deployments](#declaring-deployments)).
2. **Ingest** — events are recorded only for a pipeline with a deploy registration (a `pipeline_registry` row). `pipeline-manager pipeline deploy` registers it; a pipeline deployed any other way (CDK directly, CI) **registers itself on its first pipeline event** — see [Registration](#registration). The events Lambda parses `pb.deploys`, sets `environment` on the deploy-stage events, resolves the source **commit range in-account** (oldest unshipped commit time plus count) — **only when enabled with `setup-events --with-dora`** — and forwards normalized events to the reporting service.
3. **Compute** — DORA is derived over the **deploy-stage** executions in the window: deployment frequency, two-class change-failure rate, measured lead time, production median time to restore, and coverage.
4. **Classify** — each metric gets a `level` band (elite / high / medium / low; `insufficient` below the [minimum sample](#minimum-sample); `null` when there is no sample) and its sample size `n`.
5. **Surface** — results render as per-environment **Reports**-page cards, with `production` as the headline, or are consumed via the [endpoints](#endpoints).

## Configuration

### 1. Set an `environment` on every deploy stage

This is what makes a stage a deployment at all. See [Declaring deployments](#declaring-deployments) for the tag standard it produces, and use the literal name **`production`** for the stage you want as the headline.

### 2. Re-synth the pipelines

Deploy attribution lives in synth-time tags, so an already-deployed pipeline contributes nothing until it re-synths and runs again. Watch `coverage.withoutDeploys` to see how much of the fleet is still dark.

### 3. Turn on lead time, if you want it

```bash
pipeline-manager infra setup-events --scoped-ingest --with-dora
```

Commit-timestamp resolution makes SCM calls and reads the org's `github-token` secret **in your AWS account**, so it is **off by default** and gated on the Lambda's `DORA_ENABLED` env var. It is only worthwhile for orgs holding the `advanced_reporting` add-on; re-run to toggle after a later purchase.

With it off, **standard reporting still works** and DORA lead time reports `unknown`.

### 4. Wire your incident tooling

Point PagerDuty, Datadog, Opsgenie or Alertmanager at the incident webhook to get an automated post-deploy CFR signal and a real (median) time to restore, instead of marking deploys by hand. Full setup: [Incident webhook](incidents-webhook.md).

### 5. Tune the correlation window, and size retention

The correlation window is per-org, self-serve from **Settings → Incident Reporting** (org-admin), or via `PUT /api/reports/settings/incidents`. Retention is set by the plan and any retention packs bought in billing; see [Retention](#retention).

## Declaring deployments

A **deployment** is a pipeline **stage** that ships to an environment. You declare it by setting an `environment` on the deploy stage; pipeline-core emits two CodePipeline tags the forwarder reads:

| Tag | Value |
|---|---|
| `pb.pipeline-id` | the platform `pipelineId` (the registry join key) |
| `pb.deploys` | `<stage>:<env>` pairs joined by `+`, e.g. `Deploy-stg-alias:staging+prod-wave:production` |

`<stage>` is the **CodePipeline stage name** — the stage's `alias`, or `<stageName>-alias` when it has none — because that is the name CodePipeline events report and the forwarder matches. A stage named `Deploy-prod` with no alias therefore appears as `Deploy-prod-alias`.

- The literal environment name **`production`** is the DORA **headline**: its card is the summary, and time to restore is measured production-only.
- A stage listed in `pb.deploys` is a deploy, and the forwarder sets `environment` only on those stages' events. A stage that is **absent** is not a deployment and never enters DORA.
- `isDeploy` is **not** a field — it is derived server-side as "`environment IS NOT NULL` on a STAGE event".

## Registration

Event ingest attributes every event to a pipeline through its registry row, so a pipeline with no row reports nothing: no runs, no reports, no DORA, no scorecard.

- **`pipeline-manager pipeline deploy --id <id>`** deploys the pipeline and registers it (with its step manifest).
- **First-event self-registration.** When the forwarder posts events for a `pb.pipeline-id`-tagged pipeline that has no row, reporting asks the pipeline service to register it (`POST /pipelines/internal/registry/first-event`) and then records those events. The pipeline service registers it only when the pipeline exists, is not deleted, and belongs to an org the ingest credential was authenticated for (its own org or a descendant team). It records the CodePipeline and stack names a CLI deploy would record, and the event's region. It never overwrites an existing row. The registration is audited `pipeline.registry.register` with actor `system` and `details.source: 'first-event'`. If the call fails, the events are skipped and counted as `reporting_ingest_rejected_total{reason="unregistered_pipeline"}`, as before.
- **By hand:** **Register deployment**, on the Deployments page or on the pipeline's own page. The dialog asks which pipeline runner to register it with: with one runner (such as `default`) it asks to register with that one; with several it lists them (an unreachable one can't be picked) and pre-picks the one it is linked to now. With no runner, runners paused, or the list unreadable, it says which and registers without one. A pipeline that was never deployed (no registration, no events) is steered to **Deploy** instead, because once registered the dashboard treats it as deployed; registering it anyway needs "It was deployed another way (CDK, CI)" ticked. After registering, the dialog follows the link probe and says whether the runner found the pipeline in its AWS account. A picked runner that misses never breaks a working link to another runner. The same from the CLI: `pipeline-manager pipeline register --id <id> --runner <id or label>`.

A pipeline created in the dashboard (Generate from Git, manual create, a template) is a config until it is deployed. Its page says **Not deployed yet** with the deploy command. **Run pipeline** does not deploy: it starts an already-deployed CodePipeline through a pipeline runner. A page that says **Deployed but not registered** belongs to a pipeline that has reported before but whose registration was removed. It registers itself again on its next pipeline event.

**Run pipeline** goes by where the pipeline stands:

- **Registered and linked to a runner:** it runs through that runner.
- **Not registered:** **Register and run**. The dialog registers it with a pipeline runner (asked about, or chosen from the list, as above), and the run starts once that runner finds the pipeline in its AWS account. If the runner doesn't find it, nothing runs and the dialog says why. A never-deployed pipeline is steered to Deploy.
- **Registered, no runner linked:** choose the runner to run it with (the only one is asked about). The run (`POST /pipelines/:pipelineId/executions` with `{ runnerId }`) probes only that runner, which is linked once it finds the pipeline. A usable linked runner always wins over `runnerId`.

When the registration or the link can't be read, or the person can't register pipelines, Run starts the run and the server finds the runner.

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

A post-deploy failure is **anchored to its deploy**: it counts in the window its deploy completed in, however late it was flagged. A deploy completed on the 31st and marked failed on the 1st is the 31st's month's failure. (Windowing markers on their own time put the failure in one window and the attempt in another.) An incident opened up to the correlation window after `to` still counts for an in-window deploy. A failed marker on a deploy that already failed at deploy time adds nothing — that deployment is already one failure.

### Lead time

**MEASURED**: `median(deploy_completed − oldest_commit_time)` over successful deploys that carry a `commit_timestamp`, resolved in-account by the forwarder.

`medianSeconds` is **`null`, meaning unknown**, when no successful deploy in the environment carried a commit time. There is no run-duration fallback.

#### Why lead time is unknown

When the forwarder cannot resolve a deploy's commit range it records **why**, on the deploy (`dora_deployments.lead_time_gap`), and the DORA response counts those reasons per environment in `leadTime.unknownReasons`. The dashboard names the commonest one under an `unknown` lead time and lists every reason, with its fix, in the card's tooltip:

| Reason | Means | Fix |
|---|---|---|
| `no_token` | No SCM token for the source | Store a `github-token` secret in the AWS account the events forwarder runs in |
| `rate_limited` | The provider rate-limited the commit-range walk | Recovers on its own; a token with a higher rate limit stops it recurring |
| `unsupported_source` | The source type has no commit-range API | Lead time cannot be measured for it; use a GitHub source |
| `no_commit_data` | No commit data was reported at all | Turn on commit resolution: `pipeline-manager infra setup-events --scoped-ingest --with-dora` |

Only reasons that occurred are present; `{}` means every in-window deploy was measured (or none carried a reason). A reason a newer forwarder sends that this version does not know is counted as `no_commit_data`.

### Median time to restore

The **median** recovery time — reported in the `meanTimeToRestore` field, a historical name kept so API consumers do not break. It is a median, not a mean, and every label presents it as one.

**Production-only**, from **both** sources:

- A webhook-ingested [incident](#incidents-automated-post-deploy-failures) opened in the window contributes the **real** recovery time (`resolved_at − opened_at`).
- A manual [outcome](#post-deploy-outcomes) pair contributes `restored.at − failed.at` — measured **from the failure** (the same deploy's `failed` marker), not from the deploy.
- **Fallback:** only when a deploy has **no** `failed` marker but itself **failed at deploy time** is the failure instant the deploy's completion (`restored.at − deployed.completed_at`); that deploy-time failure also counts as the incident.
- A `restored` marker with **no** failure behind it (no `failed` marker, no incident, deploy succeeded) is not a recovery and is ignored — it adds nothing to `restored` or the median.

**Incidents take precedence** — when a deploy has both, the incident's recovery time is used.

`incidents` counts production failures; `restored` counts those that recovered; `n` is the number of recovery times measured; `medianSeconds` is `null` when none was.

### Coverage

A reconciliation: `registered` pipelines from the registry versus `deploying`, meaning pipelines with at least one deploy-stage execution in-window. `withoutDeploys = registered − deploying`.

A high `withoutDeploys` means DORA is blind to most of the fleet — either pipelines not yet re-synthed with deploy tags, or pipelines that don't deploy.

### How the stakeholder report computes them

A [stakeholder report](stakeholder-reports.md)'s DORA sections run the same queries as `/dora` and `/dora/trend` **with the org's incident correlation window** (Settings → Incident Reporting), read once per report run — so a report's change failure rate and time to restore match the dashboard for the same period, including for an org with a custom window. The window the report used is stored in its frozen snapshot (`incidentWindowHours`) and stated in its methodology footer, so a report re-opened after an admin changes the setting still says which window its numbers came from — and its numbers do not change.

## Performance levels

Each metric carries a `level` band (`elite` / `high` / `medium` / `low`; `insufficient` below the [minimum sample](#minimum-sample); `null` when there's no sample) and the sample size `n` it rests on. Thresholds follow the DORA/Accelerate reports:

| Metric | Elite | High | Medium | Low |
|--------|-------|------|--------|-----|
| **Deployment Frequency** | ≥ 1/day | ≥ 1/week | ≥ 1/month | slower |
| **Change Failure Rate** | ≤ 5% | ≤ 10% | ≤ 15% | > 15% |
| **Median Time To Restore** | < 1 hour | < 1 day | < 1 week | ≥ 1 week |
| **Lead Time** | < 1 day | < 1 week | < 1 month | ≥ 1 month |

The dashboard renders each band as a coloured badge; `null` bands show no badge.

### Minimum sample

A band needs at least **`MIN_DORA_SAMPLE` = 5** observations (exported from `@pipeline-builder/api-core`, shared by the reporting service and the maturity scorecard):

| Metric | `n` is | Below 5 |
|---|---|---|
| Deployment frequency | successful deployments | `insufficient` |
| Change failure rate | deploy attempts | `insufficient` |
| Lead time | measured commit → deploy gaps | `insufficient` |
| Median time to restore | measured recovery times | `insufficient` |

An `insufficient` band shows **"Not enough data (n = X)"** on the DORA cards, the per-pipeline view and the scorecard, and as a note on the stakeholder report's DORA section. The maturity scorecard treats it as **unscored**, exactly like `null` — never as low. The figure itself (rate, median) is still reported.

## Pipeline failure insights

The **Pipelines → Failures** tab sits beside DORA and reads the same events. Its numbers are standard reporting (`reports:read`, every tier) unless noted.

- **Stage and action failures are per pipeline.** Rows are grouped by (pipeline, stage) and (pipeline, stage, action), so two pipelines that both call a stage `Build` are two rows, each with its own rate. Each row links to that pipeline's **Runs** tab. The stakeholder `stage_failures` / `action_failures` sections read the same rows, so the numbers match.
- **Error patterns** — `GET /api/reports/execution/error-patterns`: the org's own failures grouped by the failure category the classifier assigned at ingest (`other` when it matched nothing), with the most frequent error texts in each (credential-scrubbed). Org-scoped and rollup-aware; it counts exactly the failures the operator-only `/errors` report counts, but never another org's. Every `reports:read` holder sees the panel.
- **Flaky stages** — `GET /api/reports/execution/flaky-stages`: stages that **failed and then passed on retry in the same execution**, ranked per (pipeline, stage) with the flake rate (`flaky_runs ÷ runs`) and the actions whose failure the retry overtook. A flake never shows in the failure rates — the run's final outcome was a success — which is why it has its own list. Read from raw events, so it follows event retention (the daily rollup keeps only each run's final outcome).
- **Flake rate over time** — `GET /api/reports/execution/flaky-stages/trend` (**`advanced_reporting`**): the flake rate per `interval` bucket, honouring `?tz=` / `?weekStart=` like the other trends, optionally narrowed with `?pipelineId=&stageName=`.

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
| `compare` | `previous` | — | Also return the same figures for the equal-length window just before the range — see [Period-over-period comparison](#period-over-period-comparison). |

The window is capped at the org's effective **DORA retention** (`min(730, doraRetentionDays)`, absolute ceiling **730 days**) — a wider range returns **HTTP 400** — and `from` is floored at the retention horizon (the returned `window` shows the clamp). See [Retention](#retention).

### DORA trend

```
GET /api/reports/execution/dora/trend?interval=<day|week|month>&from=<iso>&to=<iso>&tz=<iana>&weekStart=<monday|sunday>
```

Returns `data.trend` — deploy frequency plus the **same two-class** change-failure rate as the headline, bucketed by `interval` on the deploy `completed_at`. Same guards, rollup, optional scoping (`pipelineId` / `environment`) and per-org incident window as `/dora`. Each point:

```json
{ "period": "2026-07-01T00:00:00", "deployments": 4, "failed": 1, "postDeployFailures": 1, "total": 5, "changeFailurePct": 40 }
```

`failed` is deploy-time failures; `postDeployFailures` is successful deploys in the bucket later flagged failed, anchored to the deploy's bucket; `changeFailurePct = (failed + postDeployFailures) ÷ total`. Summed over the buckets, `failed`, `postDeployFailures` and `total` equal the headline's `deployTimeFailures`, `postDeployFailures` and `attempts` for the same window and scope.

| Param | Values | Default | Notes |
|-------|--------|---------|-------|
| `tz` | IANA timezone name | `UTC` | Buckets are cut at local midnight in this zone. An invalid name or a bare offset (`+05:00`) is **HTTP 400**. |
| `weekStart` | `monday`, `sunday` | `monday` | Where a `week` bucket starts. Anything else is **HTTP 400**. |

The dashboard sends the org's stakeholder-report default timezone and week start when the org has set them, otherwise the browser's timezone — so its buckets match the stakeholder report's.

### Deploy environments

```
GET /api/reports/execution/environments?from=<iso>&to=<iso>&includeDescendants=<bool>
```

The distinct deploy environments seen in the window (`data.environments`), behind the dashboard's environment filter. Same gates, retention cap and rollup as `/dora`.

### Post-deploy outcomes

```
POST /api/reports/deployments/:executionId/outcome
```

Body: `{ "outcome": "failed" | "restored", "at": "<iso>", "environment": "<name>?" }`.

Marks a deployment failed (a production incident linked to the deploy) or restored, feeding the **post-deploy** CFR component and the **median time to restore** (a `restored` marker is measured from the same deploy's `failed` marker).

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

**Idempotent** on `(org, incidentId)`: a later resolve re-post updates `resolvedAt`. Each incident is **correlated** to the most recent successful deploy to its `environment` with `completed_at ≤ openedAt` within `DORA_INCIDENT_WINDOW_HOURS` (default 24, **overridable per-org**), producing an **automated** post-deploy CFR signal and a **real** recovery time for the median time to restore.

Companion routes. The Alertmanager adapter is a machine write like `POST /incidents` (only the `reporting:ingest` scope, no feature gate); the others are org-user routes needing `reports:read` and `advanced_reporting`:

| Route | Purpose |
|---|---|
| `POST /api/reports/incidents/alertmanager` | Native Alertmanager adapter — reshapes the batched webhook payload into one incident per alert; same `reporting:ingest` auth |
| `GET` / `PUT /api/reports/settings/incidents` | Read the per-org correlation window and the two [retention](#retention) windows; set the correlation window (`{ incidentWindowHours }`, 1–720). PUT needs org-admin `org_settings:write`, and its body is strict: a retention field is a `400` |
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

### Maturity scorecard: range and grade history

The per-pipeline maturity scorecard and the org-wide leaderboard are served by the pipeline service. They score the same DORA bands as `/dora`, blended with the compliance dry-run and the security signal. See [Developer Portal](developer-portal.md#maturity-scorecards) for the scoring.

```
GET /api/pipelines/:id/scorecard?from=<iso>&to=<iso>&tz=<iana>
GET /api/pipelines/scorecard?from=<iso>&to=<iso>&tz=<iana>&offset=&limit=&project=&pipelineName=
GET /api/pipelines/:id/scorecard/history?interval=week|month&periods=<1..12>&tz=<iana>&weekStart=monday|sunday
GET /api/pipelines/scorecard/history?interval=…&periods=…&tz=…&weekStart=…&offset=&limit=&project=&pipelineName=
```

- **Range.** `from` / `to` are optional. With neither, the window is the trailing 30 days and the response is unchanged. An explicit window is capped at the org's DORA retention width and `from` is floored at the retention horizon, the same rule `/dora` applies, using the account root's retention. An invalid `tz` or an inverted or over-wide range returns 400. The scorecard is one aggregate over the window, so `tz` only changes the grade history's window boundaries.
- **Grade history.** Returns the score and grade for each of the last `periods` (default and maximum 12) calendar weeks or months, oldest first. Windows are bounded in `tz`, and weeks start on `weekStart`. The current window is cut off at now (`partial: true`). A window the retention horizon cuts starts at the horizon (`truncated: true`), and a window wholly before it is left out. Nothing is stored: each window is scored on the fly with the scorecard's own function, so a point equals `GET …/scorecard?from=<point.from>&to=<point.to>`. Compliance and security are current-state signals, read once and applied to every window, so the history moves with delivery (DORA) only. Weekly windows often have fewer than 5 deploys, and their DORA bands are then unscored ("Not enough data"), the same as on the card. A window whose DORA scan fails is `unavailable` (a gap, never an F).
- **Org history.** Covers the same page of pipelines as the leaderboard. It returns each window's org `averageScore` and `grade`, which equal the leaderboard's `averageScore` for that window, plus every row's points, so the leaderboard draws its per-row strips from one read. It costs up to `limit × periods` per-pipeline DORA scans, runs `ORG_SCORECARD_CONCURRENCY` at a time, and is reused for 5 minutes per viewer and query, like the roll-up.
- **Gates.** All four need `advanced_reporting`. The per-pipeline card and its history are on `pipelines:read`, because roles that hold `pipelines:read` without `reports:read` see the pipeline page today. The org leaderboard and its history are reporting data and use `reports:read`. See [Permission Contract](permission-contract.md#maturity-scorecard-routes).

## Retention

Reporting rows do not live forever. A leader-locked background sweep in the reporting service hard-deletes expired rows by `created_at` on a **split** schedule, so high-volume standard events expire faster than the low-volume DORA source. Both windows are **per org**, written by billing; unset falls back to a global env default.

| Window | Covers | Default | Env default | Per-org value (billing-synced) |
|--------|--------|---------|-------------|------------------|
| **Standard events** | `pipeline_events` with `environment IS NULL` and no `commit_timestamp` (non-deploy STAGE/ACTION/build activity) | **30 days** | `REPORTING_EVENT_RETENTION_DAYS` | `dora_settings.event_retention_days` |
| **DORA source** | `pipeline_events` with `environment IS NOT NULL` (deploy stages) or a `commit_timestamp` (the source events lead time joins on) + all `deployment_outcomes` + all `incidents` | **180 days** | `REPORTING_DORA_RETENTION_DAYS` | `dora_settings.dora_retention_days` |

**Retention is tier-aware and bundle-extendable.** Each tier carries a baseline window that seeds these two values: paid tiers default to 30 days (standard events) and 180 days (DORA source), while the **unlimited** tier is **unlimited retention** (the `-1` sentinel) — the sweep **skips the org entirely** and keeps all history forever.

Effective retention = tier baseline + Σ(add-on pack grant), so the **[Standard Retention Pack](billing-bundles.md)** adds +90 standard-event days and the **DORA History Pack** adds +365 DORA-source days on top of the baseline. Billing computes that effective window and syncs it into `dora_settings` (`PUT /reports/internal/retention-sync/:orgId`, billing's service token only); nothing else writes those columns.

**Reading it.** **Settings → Incident Reporting → Retention** shows both windows read-only, with a link to the retention packs. `GET /api/reports/retention` (`reports:read`, no `advanced_reporting`) returns the effective `eventRetentionDays` / `doraRetentionDays` and the widest range each report serves. Values are **1–730 days**, or the `-1` unlimited sentinel from the unlimited tier.

**The report-query window tracks per-org retention.** Each org's query cap is `min(730, orgRetentionDays)`: DORA/CFR/MTTR routes cap by the **DORA** window, standard-event routes cap by the **standard-event** window. So a base org can't request a range past its retention — which would be empty anyway — while a **DORA History Pack** org can query the full extended range. The **absolute ceiling stays 730 days**, and an unlimited-tier (`-1`) org queries right up to it. System-admin cross-org report routes keep the flat 730-day ceiling and are not per-org capped.

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
          "deploymentFrequency": { "deployments": 128, "perDay": 4.27, "level": "elite", "n": 128 },
          "changeFailureRate": { "rate": 7.9, "deployTimeFailures": 8, "postDeployFailures": 3, "attempts": 139, "level": "high", "n": 139 },
          "leadTime": { "deployments": 120, "medianSeconds": 5400, "level": "high", "n": 120, "unknownReasons": { "no_token": 8 } }
        }
      ],
      "meanTimeToRestore": { "incidents": 4, "restored": 3, "medianSeconds": 1840, "level": "insufficient", "n": 3 },
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
| `environments[].deploymentFrequency` | `deployments` (successful deploys), `perDay`, `level`, `n` |
| `environments[].changeFailureRate` | Two-class: `rate`, `deployTimeFailures`, `postDeployFailures`, `attempts`, `level`, `n` |
| `environments[].leadTime` | `deployments` (median sample), `medianSeconds` (`null` = unknown), `level`, `n`, and `unknownReasons` — deploys whose lead time could not be measured, per [reason](#why-lead-time-is-unknown) |
| `meanTimeToRestore` | The **median** time to restore (historical field name). Production-only: `incidents`, `restored`, `medianSeconds` (`null` when none), `level`, `n` |
| `coverage` | `registered`, `deploying`, `withoutDeploys` |
| `*.level` | [Performance band](#performance-levels): `elite` / `high` / `medium` / `low`, `insufficient` (0 < `n` < 5), or `null` (no sample) |
| `*.n` | The sample the band rests on (see [Minimum sample](#minimum-sample)) |

## Delivery

**Reports → Delivery** answers two questions the DORA tab does not: are our cross-account runners actually taking runs, and what did we ship, day by day.

### Run latency and runner reliability

Free on every tier (`reports:read`). Read from the run requests the platform sends to your [pipeline runners](aws-deployment.md#cross-account-pipeline-runner):

- **What counts.** Start and stop requests in the range, by request time. Discovery probes and deploys through a runner are not runs and are left out.
- **Outcomes.** *Started* (the runner accepted it), *failed*, *expired* (not delivered before the request lapsed), *refused* (the runner answered 401/403: bad signature, refused, permission denied) and *pending* (still queued or delivering). The failure rate is failed + expired + refused over everything that finished; pending requests are in neither side.
- **Time to start.** Median and p90 time from the request to its `accepted_at`, the moment the runner accepted it, over accepted start requests. The pipeline service records `accepted_at` on every start or stop a runner accepts. `n` is the sample size; the card shows it as, for example, *p90 1m · n = 12*.
- **Failure codes.** The top codes from the runner error catalog. A stored code outside the catalog is counted as `OTHER`.
- **Runners.** Every runner the range's requests went through, your own runners even when idle, and every runner a parent (or higher) organization shares with teams, even when idle. The parent chain is read from the platform. If that lookup fails, idle shared runners are left out and the report still loads. Each row has requests, failure rate, expired count, current health and last delivery. A parent organization's runner shows its label and health only while it is still shared with teams; after that it is listed as "Unshared runner". No function URL, signing key or requester is ever returned.

Bucketed by the report interval in the org's reporting timezone and week start, like the other dashboard series. Bounded by event retention. **Include child teams** rolls the teams in for `reports:rollup` holders; a team's own runner then counts as the organization's.

### Deployment calendar and change volume

Advanced Reporting (`advanced_reporting`); without it the panel is locked and no request is made. Read from the recorded deployments (one per execution and environment, kept for DORA retention):

- **Calendar.** Deployments per day per environment, with days counted in the org's reporting timezone. An outlined day had a deploy that failed.
- **Commits per deploy.** Median and p90 over deploys with a known commit count (the same count lead time uses).
- **Production deploys.** Every production deploy in the range (the latest 200 are listed; the count is exact) with pipeline, time, commit count and outcome: *Succeeded*, *Failed* (the deploy itself failed) or *Failed after deploy* (marked failed afterwards with a [post-deploy outcome](#post-deploy-outcomes)). Incident-correlated failures count in the DORA tab's change-failure rate, not here.

Each table has a CSV export.

### Delivery endpoints

```
GET /api/reports/delivery/runners?from=&to=&interval=week&tz=&weekStart=&includeDescendants=
GET /api/reports/delivery/calendar?from=&to=&tz=&includeDescendants=
```

`runners` needs `reports:read`; `calendar` needs `reports:read` and `advanced_reporting`. Both answer `400` for a bad interval, timezone or week start, or a range past retention (event retention for `runners`, DORA retention for `calendar`). Date-only bounds are local midnights in `tz`.

## Flow

**Reports → Flow** shows where pipeline time goes waiting rather than working. Both panels read the raw pipeline events (a median or p90 cannot be rebuilt from daily totals), so they are bounded by event retention. An empty panel says so.

### Queue and wait time

Free on every tier (`reports:read`):

- **Queue time.** How long a CodeBuild action waited for capacity (CodeBuild's `QUEUED` phase).
- **Provisioning time.** How long its build environment took to set up (the `PROVISIONING` phase).
- **Start to first stage.** From a pipeline execution's start to its first stage's start, from the existing pipeline and stage events. A retried stage's restart is not a first start, and an execution without a stage event is left out.

Median, p90 and `n` for each, plus a table by compute type and the actions with the longest total wait (p90 of queue + provisioning). The events Lambda reads both phases from the same `BatchGetBuilds` call it already makes for the compute size when a CodeBuild action finishes, so collecting them costs no extra AWS call. A phase CodeBuild did not report is left out, never counted as zero. CodeBuild's own build-state events name a build project, not a pipeline, so they are not used. A build counts in the period it finished in.

**Advanced Reporting** adds the per-period trend of the same figures. Without it the trend is locked and not requested.

### Approval wait time

Advanced Reporting (`advanced_reporting`). Without it the panel is locked and no request is made.

- **What counts.** Manual approval actions (CodePipeline's `Approval` action category, kept in the stored event) that finished in the range, counted in the period they finished in.
- **Wait.** The approval action's start to its decision. When AWS sent no start time, the action's own start event is used. Median and p90 are taken over decided approvals only.
- **Rejected or expired.** AWS reports a rejection and an expired approval the same way (failed), so they are one count. An approval left without a decision (its execution was stopped, superseded or abandoned) is counted, but has no wait.
- **Slowest approval stages.** Per pipeline and stage, ranked by p90 wait, with the longest single wait.

Each table has a CSV export. Every figure is org-scoped, includes child teams for `reports:rollup` holders when **Include child teams** is on, and uses the org's reporting timezone and week start. Nothing is reported per person.

### Flow endpoints

```
GET /api/reports/flow/queue?from=&to=&tz=&includeDescendants=
GET /api/reports/flow/queue/trend?from=&to=&interval=week&tz=&weekStart=&includeDescendants=
GET /api/reports/flow/approvals?from=&to=&interval=week&tz=&weekStart=&includeDescendants=
```

`queue` needs `reports:read`; `queue/trend` and `approvals` also need `advanced_reporting`. All answer `400` for a bad interval, timezone or week start, or a range past event retention. Date-only bounds are local midnights in `tz`.

## Period-over-period comparison

The DORA cards and the Pipelines overview's success rate show a chip with the change against the **equal-length window immediately before** the range: ▲/▼, the magnitude, and green when the change is an improvement, red when it is not. Deployments and success rate are better higher; change failure rate, lead time and time to restore are better lower. A change smaller than the displayed precision reads as "no change". A side with no value (an unknown lead time, no deploy attempts, no runs) shows no chip.

```
GET /api/reports/execution/dora?from=&to=&compare=previous
GET /api/reports/execution/success-rate?from=&to=&interval=&tz=&weekStart=&compare=previous
```

`compare=previous` returns the usual body plus `previous`: for `/dora`, a second `DoraMetrics` for the previous window; for `/success-rate`, `{ window, timeline }`. Both reads are inclusive at both ends, so the previous window ends one millisecond before `from` and a run on the boundary counts once. The same scoping (`pipelineId`, `environment`, `includeDescendants`), incident window and bucketing apply to both windows. `previous` is `null` when the previous window would start before the retention horizon (DORA retention for `/dora`, event retention for `/success-rate`): that data is purged, and a partial window is not a fair comparison. Any other `compare` value is **HTTP 400**.

The comparison is **Advanced Reporting**. `/success-rate` itself stays free; asking it for `compare=previous` without `advanced_reporting` is refused with **403** (the check runs in the route, so the generated route table still shows `/success-rate` as `reports:read`). The dashboard never asks without the entitlement, and shows no chips.

**Stakeholder reports compare differently.** A saved report compares each period against the **previous calendar period** (last month against the month before, last week against the week before, in the report's timezone and week start), not against an equal-length rolling window, so a report's trend column and a dashboard chip over a similar range can differ.

## Team benchmarking

**Reports → Teams** puts every team in the organization's org → team hierarchy side by side, plus the organization itself: deployment frequency (per day), change failure rate, lead time and median time to restore, each with its [band](#performance-levels) and the [minimum-sample](#minimum-sample) rule (`Not enough data (n = X)` below 5), then success rate and run count. The table sorts by any column (the organization's own row stays first; blanks sort last) and exports to CSV. An organization with no teams gets an empty state.

- **A team's row is that team's own dashboard.** Each row is computed with the same reads the team's DORA and Pipelines tabs make, for the team's org alone, in the team's own tenant scope, with its own incident correlation window. The organization's row is its **own** figures, not the rollup (what its dashboard shows with **Include child teams** off).
- **Windows.** The DORA cells use the range capped and floored to DORA retention, the success rate the range capped and floored to event retention, the same as `/execution/dora` and `/execution/success-rate`. Success rate is succeeded ÷ (succeeded + failed + canceled) over the success-rate report's buckets, bucketed in the org's reporting timezone and week start.
- **Team level only.** There is no per-person view, and the table never ranks individuals.
- A team whose figures could not be read shows an error in its own row; the rest of the table still loads.

```
GET /api/reports/benchmark/teams?from=&to=&interval=week&tz=&weekStart=
```

Needs `reports:read`, **`reports:rollup`** (looking down into the teams, the same capability a rollup read needs) and **`advanced_reporting`**. Without the entitlement the tab shows the upsell; without `reports:rollup` it explains the permission. Neither makes a request. The subtree is resolved strictly: if the platform cannot answer, the route returns **503** rather than a one-row table. `400` for a bad interval, timezone or week start, or a range past retention. The body is `data.benchmark`: `{ hasTeams, window: { dora, events, tz, weekStart }, rows }`, each row `{ orgId, name, role: 'parent' | 'team', state: 'ok' | 'failed', environment, deploymentFrequency, changeFailureRate, leadTime, timeToRestore, successRate }`, the DORA cells as `{ value, level, n }`.

## Related

- [Incident webhook](incidents-webhook.md) — automated post-deploy CFR and real recovery times from your incident tooling
- [API Reference](api-reference.md) — full reporting endpoint list
- [AWS Deployment — Report API Endpoints](aws-deployment.md#report-api-endpoints)
- [Roles & Permissions](permissions.md) — `reports:read` and `reports:rollup`
- [Billing Add-on Bundles](billing-bundles.md) — how tier feature entitlements such as `advanced_reporting` work
- [Stakeholder Reports](stakeholder-reports.md) — the scheduled, manager-facing reports these metrics feed
