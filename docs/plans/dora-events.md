# Plan — DORA-grade event reporting for `setup-events`

Status: **in progress** (Phases 1–4 + 3b). Phase 5 (incident webhook) is designed here but deferred.

## Guiding principle
DORA facts that need repo or production-incident knowledge can only be captured **in the user's AWS account** (source token, CodeConnections, deployed app) or **provided by the user** — the platform can't read repos (OAuth is SSO-only) and can't see the user's production. So:

> Capture facts in-account (forwarder / synth) → forward normalized events → the platform only **computes** DORA over ingested facts.

## Hard constraints
- **No new AWS services.** `setup-events` keeps its current resource types only (EventBridge rule + SQS + DLQ + Lambda + IAM). No CloudWatch alarms/SNS/Scheduler. Health/observability surfaces through the platform reporting service + the existing in-cluster Prometheus/Alertmanager.
- **No backward compatibility.** Old tags, the proxy lead-time, run-basis frequency, and inferred CFR/MTTR are **removed**, not kept beside the new behavior. Forward-only, fresh-install — historical pre-cutover data is excluded, no migration/backfill. Already-deployed pipelines produce no DORA data until they re-synth; the panel starts empty and fills forward (expected, not a regression).

---

## Implementation contract (single source of truth for all packages)

### Tags (pipeline-core generates → forwarder parses)
| Tag | Value |
|---|---|
| `pb.pipeline-id` | `<platform pipelineId>` (replaces `PIPELINE_EVENT_ID`) |
| `pb.deploys` | `<stage>:<env>` pairs joined by `+`, e.g. `Deploy-stg:staging+Deploy-prod:production`. CodePipeline-tag-safe (`:` `+` allowed; **no JSON**). |

- `production` (literal env name) = DORA headline. A stage in `pb.deploys` is a deploy; absent ⇒ not a deploy.
- User declares it by setting `environment` on the deploy stage; pipeline-core derives `pb.deploys`.

### Event fields (forwarder → ingest `POST /api/reports/events`)
Existing: `pipelineId, eventSource, eventType, status, executionId, stageName, actionName, errorMessage, startedAt, completedAt, durationMs, commitSha, commitRef, environment, idempotencyKey, detail`.
**New (Phase 4):** `commitTimestamp?` (ISO 8601), `commitCount?` (int ≥1).
`isDeploy` is **not a field** — derived server-side as `environment IS NOT NULL` on a STAGE/ACTION event (the forwarder sets `environment` only for stages listed in `pb.deploys`).

### Schema (postgres — all 4 `postgres-init.sql` copies + `pipeline-data` schema/query layer)
- `pipeline_events` add: `commit_timestamp TIMESTAMPTZ`, `commit_count INTEGER`. Index `(org_id, environment, completed_at)`.
- New `deployment_outcomes(execution_id VARCHAR, org_id VARCHAR, environment VARCHAR, outcome VARCHAR CHECK IN ('failed','restored'), at TIMESTAMPTZ, created_at TIMESTAMPTZ)`; index `(org_id, environment)`, `(execution_id)`.
- New `ingest_health(org_id VARCHAR PRIMARY KEY, last_event_at TIMESTAMPTZ, forwarded BIGINT, dropped BIGINT, updated_at TIMESTAMPTZ)`.
- Idempotent init only (`CREATE TABLE IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS`). No migration/backfill.

### Reporting endpoints
- `POST /api/reports/deployments/:executionId/outcome` `{outcome:'failed'|'restored', at, environment}` — `advanced_reporting`-gated. Phase 2.
- `POST /api/reports/ingest-health` `{forwarded, dropped, lastEventAt}` — from the Lambda. Phase 3.
- `GET /api/reports/dora` (existing) — rewritten compute (below).
- Prometheus metrics exposed on ingest (Phase 3b): `pipeline_stage_result_total{pipeline_id,stage,environment,org_id,result}`, `pipeline_deploy_result_total{environment,org_id,result}` (`result`=succeeded|failed).

### DORA compute (rewrite in `reporting-service.ts`)
- **Deployment frequency** = successful deploy-stage executions per environment; headline `production`. (run-basis removed.)
- **Lead time** = `deploy_completed − oldest_commit_time` (from `commit_timestamp`); `unknown` when unresolvable. (proxy removed.)
- **CFR** (per env) = `(deploy-time failures + post-deploy failures) / deploy attempts`.
  - deploy-time failure = deploy stage `result=failed` (from events).
  - post-deploy failure = a successful deploy later marked/incident-linked (from `deployment_outcomes`).
  - payload returns `{rate, deployTimeFailures, postDeployFailures, attempts}`. (inferred CFR removed.)
- **MTTR** = median(`restored.at − deployed.completed_at`) over post-deploy incidents (from `deployment_outcomes`). Production-only. (inferred MTTR removed.)
- **Coverage** = registered pipelines (platform registry) with no observed deploys in-window.
- Clamp all cross-source time deltas ≥0.

---

## Phases

### Phase 1 — Deploy signal + per-stage environment → precise Deployment Frequency + deploy-time CFR
- `pipeline-core`: emit `pb.pipeline-id` + `pb.deploys`; drop `PIPELINE_EVENT_ID`/`Environment`.
- Forwarder: parse `pb.deploys`; set per-stage `environment` on deploy-stage events.
- Reporting: deploy-basis frequency per env; deploy-time CFR from events; coverage reconciliation.
- Frontend: per-stage **Environment** field; DORA panel per-env.
- Schema: index only. Docs: `docs/dora-metrics.md`, `packages/pipeline-events/README.md`.

### Phase 2 — Manual mark failed/restored → real post-deploy CFR + MTTR
- Reporting: `deployment_outcomes` table + outcome endpoint; CFR post-deploy component; MTTR.
- Frontend: mark-failed/restored on the deploy list.
- Removes inferred CFR/MTTR.

### Phase 3 — Harden delivery (no new AWS service)
- Lambda **self-healing redrive**: on a successful batch, if DLQ non-empty and no move task active, `sqs:StartMessageMoveTask(DLQ→main)`. Guards: success-gated, one-at-a-time (`ListMessageMoveTasks`), throttled; idempotent ingest prevents double-count. IAM: add `sqs:StartMessageMoveTask/ListMessageMoveTasks/GetQueueAttributes` to the Lambda role.
- Lambda emits **ingest-health** to `/api/reports/ingest-health`; Reports UI shows flowing/stale/dropping.
- `pipeline-manager infra redrive-events` — manual fallback.

### Phase 3b *(optional)* — Pipeline/stage-failure metric + alerting
- Reporting exposes the Prometheus metrics above; reporting pod scraped.
- Stock rules in `alert-rules.yml`: `PipelineDeployFailed`, `PipelineStageFailureRateHigh`; users can add per-org rules. Alertmanager routes as today. Absent under LEAN.
- CI/pipeline-failure notification — distinct from production incidents.

### Phase 4 — True Lead Time (in-account, commit range)
- Forwarder resolves commit timestamps for `last_deployed_sha..current_sha` in-account per source type (CodeCommit `GetCommit`; GitHub/Bitbucket via the org's `github-token` secret; CodeConnections). Batch + cache; oldest-unshipped commit.
- Forward `commitTimestamp` + `commitCount`; ingest accepts.
- Reporting: measured lead time; `unknown` fallback (proxy removed). Columns `commit_timestamp`, `commit_count`.
- **Entitlement gate (add-on).** DORA lead time is an `advanced_reporting` add-on, so the commit enrichment (SCM calls + `github-token` read) is **gated on `DORA_ENABLED`**, set by **`setup-events --with-dora`** (CFN `DoraEnabled` param → Lambda env var). Off by default: orgs without the add-on skip the SCM/secret cost entirely while **standard reporting still forwards** (`commitSha` + all other fields). Toggle by re-running `setup-events` after purchase (chosen over a live entitlement lookup for simplicity; stale until re-run).

### Phase 5 — Incident webhook (automated post-deploy CFR + real MTTR)
- New `incidents(incident_id UNIQUE, org_id, environment, opened_at, resolved_at, severity, created_at)` table (all 4 postgres-init + pipeline-data schema).
- `POST /api/reports/incidents {incidentId, environment, openedAt, resolvedAt?, severity}` — machine `reporting:ingest` scope (same credential as event ingest), **idempotent on `incident_id`** (upsert; a later resolve updates `resolved_at`). From the user's PagerDuty/Datadog/Alertmanager.
- **Correlation:** each incident → the most recent **successful** deploy to `environment` with `completed_at ≤ opened_at` within a **configurable window** (`DORA_INCIDENT_WINDOW_HOURS`, default 24). That deploy is a **post-deploy failure**.
- **DORA integration** (reconciles with Phase 2): a successful deploy is a post-deploy failure if it has a correlated incident **or** a manual `failed` outcome — **dedup by execution** (don't double-count). MTTR uses the incident's `resolved_at − opened_at` when incident-sourced, else the manual `restored − deployed`; incidents take precedence. `meanTimeToRestore` and CFR `postDeployFailures` now draw from both sources.
- Docs: new `docs/incidents-webhook.md` (contract, per-org auth, payload, idempotency, window, "point your Alertmanager/PagerDuty/Datadog here") + `docs/dora-metrics.md` + index entries.

### Phase 6 — Per-pipeline build breakdown (build health, alongside DORA)
- **No new table** — aggregate from existing `pipeline_events` (STAGE/ACTION `duration_ms`, `result`) + `plugin-build` events.
- `GET /api/reports/build-health?pipelineId=&from=&to=` (`reports:read`; NOT `advanced_reporting` — build health is standard) → per-stage build metrics: `{ stages: [{stage, runs, successes, failures, successRate, p50Ms, p90Ms, p99Ms}], totals: {runs, failures, failureRate} }` (agent finalizes exact shape and owns both ends).
- **Frontend:** a **Build Health** sub-panel on the Reports page, keyed by the scoped pipeline, *next to* (not inside) DORA — stage timing percentiles + per-stage success rate. Available on every tier.
- Docs: `docs/dora-metrics.md` cross-ref / Execution Analytics.

---

## Cross-cutting
- **Schema-sync rule:** a schema change lands in all **4** `postgres-init.sql` copies + `pipeline-data` schema + query layer.
- **Docs-with-code rule:** each phase ships its doc update; new pages get a `docs/README.md` + `docs/content-index.md` index entry.
- **Idempotency:** ingest dedupes on `idempotencyKey`; outcomes keyed by `execution_id`.
- **Gating:** DORA + outcome endpoints stay `advanced_reporting`-gated.
- **Validation:** golden-dataset fixture tests per metric in `reporting-service` tests.
- **Deploy footprint (all prebuilt images):** `pipeline-events`, `pipeline-core`, `api/reporting`, `pipeline-data`, `pipeline-manager`, `frontend`, `platform`, + 4 postgres-init copies + prometheus/alert-rules config.

### Phase 7 — Reporting retention (split, per-org)
Records currently grow **unbounded** — no TTL/purge on `pipeline_events`/`deployment_outcomes`/`incidents`. Add a **split, per-org** retention sweep.
- **Two windows** (high-volume events vs low-volume DORA source):
  - **Standard events** — `pipeline_events` with `environment IS NULL` (non-deploy STAGE/ACTION/build): default **30 days** (`REPORTING_EVENT_RETENTION_DAYS`).
  - **DORA source** — `pipeline_events` with `environment IS NOT NULL` (deploy stages) + `deployment_outcomes` + `incidents`: default **180 days** (`REPORTING_DORA_RETENTION_DAYS`) — ~2 quarters, enabling quarter-over-quarter DORA. (The report window still hard-caps at 365; making the effective query cap track per-org retention is Phase 8.)
- **Per-org override:** add `event_retention_days` + `dora_retention_days` (both nullable → global default) to the existing `dora_settings` table (all 4 postgres-init + pipeline-data). Tier-align the allowed max (`advanced_reporting`/Enterprise may raise it).
- **Sweep:** a **leader-locked** scheduled job (reuse the platform's scheduler/leader-lock pattern, e.g. `createScheduler` + the soft-delete sweep's leader lock) in the reporting service — batched deletes per org by `created_at` age against each window. No new AWS services.
- **Settings + UI:** extend `GET/PUT /api/reports/settings/incidents` (or a sibling reporting-settings route) with the two retention values; surface them on the org-admin reporting/incident settings panel (org-admin + `advanced_reporting`).
- **Bounded tables** (`ingest_health`, `dora_settings`) are never purged.
- Docs: retention section in `docs/dora-metrics.md` (note reports only see 365 days regardless).

### Phase 8 — Retention add-on bundles + per-org query cap  ✅ IMPLEMENTED (2026-08-20)
Let orgs **buy** longer retention via the existing stackable-bundle engine (`effective = tierBase + Σ(grant × qty)`), and make the extra history actually queryable. Builds on Phase 7's per-org `dora_settings` retention fields.

- **Tier-aware retention (make retention a tier dimension):**
  - **Unlimited tier → unlimited retention** — baseline `-1` sentinel ⇒ the sweep **skips** those orgs entirely (keep all history forever), consistent with how the unlimited tier makes quotas unlimited. This is the fresh-install / billing-disabled default, so "unlimited tier" honestly means unlimited history.
  - **Paid tiers → 30 (standard) / 180 (DORA)** baselines; bundles add on top (`effective = tierBase + Σ(grant × qty)`), and the tier sets the **allowed max**. A `-1` (unlimited) at any level makes the sweep skip that org.
  - The retention baseline joins the tier config alongside the existing quota baselines; billing syncs the effective value to `dora_settings` (below).
- **Two stackable packs** (billing catalog; prices are env-overridable defaults, annual = 10× monthly):
  - **Standard Retention Pack** — `+90 days` standard event retention (base 30 → 120 → 210…). All tiers. Suggested **$15 / $150**.
  - **DORA History Pack** — `+365 days` DORA retention **and** `+365 days` on the per-org report-query window. Requires `advanced_reporting`. Base 180 → 545 → 910… Suggested **$30 / $300**. (Optional *Analytics Suite* combo: Advanced Reporting + DORA History at a discount.)
- **Billing → reporting sync (new target):** billing computes the effective retention entitlement and syncs it to the org's `dora_settings` (`event_retention_days` / `dora_retention_days`) — mirroring how it syncs quotas→quota-service and seats/features→platform; pooled at the **account root**.
- **Per-org query cap (the Phase-7 coupling, landed here):** replace the hard `MAX_REPORT_RANGE_DAYS = 365` constant with a **per-org effective cap** = `min(hardMax, org.doraRetentionDays)` for DORA routes (and `event` retention for standard routes) — so a base org (180d) can't request empty windows, and a DORA-History-pack org queries the full extended range.
- **Marketplace metering:** register the two packs' metered dimensions (`AWS_MARKETPLACE_BUNDLE_DIMENSION_MAP` / `dimensionPriceMap`), like the other packs.
- **Files:** `api/billing` (bundle catalog + retention grants + the reporting sync), `api/reporting` (per-org query cap), `packages/pipeline-data` (settings write already exists from Phase 7), frontend (the generic addons/preview UI surfaces the packs automatically), docs (`billing-bundles.md` rows + combo, `dora-metrics.md` "retention is bundle-extendable").
- **Depends on Phase 7** (the per-org retention fields + sweep). No new AWS services.

## Out of scope
Raw per-CodeBuild-project metrics (events skipped), incident webhook (Phase 5), platform-side SCM credential store, non-DORA analytics, any migration/compat layer.
