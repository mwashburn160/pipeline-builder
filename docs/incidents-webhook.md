---
layout: default
title: Incident Webhook
image: /assets/og-image-solution.png
---

# Incident Webhook

## Overview

The **incident webhook** turns your existing incident tooling (PagerDuty, Datadog,
Opsgenie, in-cluster Alertmanager, or any system that can POST JSON) into an
**automated** source of two [DORA metrics](dora-metrics.md):

- **Change Failure Rate (CFR)** — a production incident correlated to a deploy makes that deploy a **post-deploy failure**.
- **Mean Time To Restore (MTTR)** — a resolved incident supplies the **real** recovery time (`resolved_at − opened_at`), rather than a manually-marked one.

Point your incident tool at `POST /api/reports/incidents` once, and DORA fills in
CFR + MTTR automatically — no more clicking **Mark failed / Mark restored** by hand
(the manual [post-deploy outcomes](dora-metrics.md#post-deploy-outcomes) path still
works and is deduped against incidents).

> Incident data only surfaces through DORA, which is an **`advanced_reporting`**
> feature (Enterprise, or the [Advanced Reporting add-on](billing-bundles.md)).
> Ingesting incidents without the entitlement is harmless — they're stored but
> never shown.

## Authentication

The endpoint is a **machine** endpoint, authorized by the **`reporting:ingest`**
token scope — the **same org-scoped credential** the event forwarder holds. The
org is taken from the **token identity**, never from the request body, so a token
can only file incidents for its own organization.

Send the token as a bearer credential:

```
Authorization: Bearer <reporting:ingest-scoped token>
```

### Getting a token (self-serve)

The webhook token is a **Personal Access Token scoped to `reporting:ingest`** —
org-bound and **least-privilege** (the scope forces `role=member` with no
features/permissions, so even an admin's webhook token can only file incidents).
Two ways to mint one:

- **Admin UI (recommended)** — **Settings → Incident Reporting → Webhook token →
  Generate webhook token**. It re-prompts for your password (step-up) and shows
  the token **once** — copy it immediately. **To rotate:** generate a new one and
  revoke the old token on the **API Tokens** settings page. (Under the hood this
  is `POST /api/user/pats` with `{ scope: "reporting:ingest" }`.)
- **CLI** — for the in-AWS-account event forwarder credential (stored in Secrets
  Manager with auto-renewal), use `pipeline-manager infra store-token --scope
  reporting:ingest`. See [Onboarding → store the service token](onboarding.md).

## Contract

```
POST /api/reports/incidents
Content-Type: application/json
Authorization: Bearer <token>
```

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `incidentId` | string (≤255) | yes | Your incident tool's stable id. **Unique per org** — the idempotency key. |
| `environment` | string (≤255) | yes | The affected deploy environment (e.g. `production`). Must match the `environment` you declared on the deploy stage. |
| `openedAt` | ISO 8601 (offset) | yes | When the incident opened. Used for deploy correlation. |
| `resolvedAt` | ISO 8601 (offset) | no | When it resolved. Omit for an open incident; send a follow-up POST to set it. |
| `severity` | string (≤50) | yes | Free-form (`critical`, `P1`, `warning`, …). |

Example:

```json
{
  "incidentId": "PD-4821",
  "environment": "production",
  "openedAt": "2026-08-20T14:05:00Z",
  "resolvedAt": "2026-08-20T14:52:00Z",
  "severity": "critical"
}
```

Response: `200` `{ "data": { "incidentId": "PD-4821", "ok": true } }`. Validation
failures return `400 VALIDATION_ERROR`; a token without the `reporting:ingest`
scope returns `403`.

## Idempotency

Incidents are keyed on **`(org, incidentId)`**. Posting the same `incidentId`
again is an **upsert**, not a duplicate — the typical flow is two POSTs:

1. **On open** — `openedAt` set, `resolvedAt` omitted.
2. **On resolve** — the same `incidentId` with `resolvedAt` now populated.

The resolve POST updates `resolvedAt` (and any changed fields) in place. Retries
and at-least-once webhook deliveries are therefore safe.

## Correlation window

Each incident is attributed to the **most recent successful deploy** to its
`environment` whose `completed_at ≤ openedAt`, **within `DORA_INCIDENT_WINDOW_HOURS`**
(default **24**, configurable on the reporting service). That deploy becomes a
post-deploy failure, and — if the incident resolves — supplies the MTTR gap.

- An incident with **no** eligible deploy in the window is **not** attributed (it contributes nothing to CFR/MTTR) — it can't be blamed on a specific deploy.
- The window boundary is **inclusive** (exactly 24h correlates; one second past does not).
- **Dedup:** if a deploy is flagged by **both** an incident and a manual `failed` outcome, it counts as **one** post-deploy failure, and the **incident takes precedence** for MTTR.

### Per-org correlation window

The window defaults to `DORA_INCIDENT_WINDOW_HOURS` (24) on the reporting service,
but an **org admin can override it per-org** (1–720 hours) — in the [Admin
UI](#admin-ui) or via the endpoint:

```
GET  /api/reports/settings/incidents      # read { incidentWindowHours, defaultWindowHours,
                                          #        eventRetentionDays, doraRetentionDays,
                                          #        defaultEventRetentionDays, defaultDoraRetentionDays }
PUT  /api/reports/settings/incidents       # any subset of { "incidentWindowHours": 12,
                                          #   "eventRetentionDays": 45, "doraRetentionDays": 200 }
```

Both require `reports:read` + `advanced_reporting`; the **PUT additionally requires
the org-admin `org:settings`** permission. The PUT is a **partial** upsert — send
any subset; omitted fields are left unchanged. When set, the correlation-window
override is used everywhere the correlation runs (DORA CFR/MTTR, the incidents
list, and the test dry-run); when unset, the env default applies. The same
endpoint carries the two **retention** overrides (`eventRetentionDays` /
`doraRetentionDays`, 1–730 days) — see **[DORA Metrics → Retention](dora-metrics.md#retention)**.

## Alertmanager adapter (native)

In-cluster Prometheus **Alertmanager** posts a *batched* payload (`{status,
alerts:[…]}`) — a different shape than the generic contract. Point a
[`webhook_config`](https://prometheus.io/docs/alerting/latest/configuration/#webhook_config)
receiver at the **native adapter** instead, and it reshapes the batch into one
incident per alert:

```
POST /api/reports/incidents/alertmanager
Authorization: Bearer <reporting:ingest token>
```

Mapping (per alert):

| Incident field | From |
|----------------|------|
| `incidentId` | alert `fingerprint` (falls back to the payload `groupKey`) |
| `environment` | the `environment` **label** (override the label name with `?environmentLabel=<label>`) |
| `severity` | the `severity` label (defaults to `unknown`) |
| `openedAt` | `startsAt` |
| `resolvedAt` | `endsAt`, only when the alert `status` is `resolved` (Alertmanager's "no end" zero value is ignored) |

Same `reporting:ingest` auth + idempotent `(org, incidentId)` upsert as the generic
route. Alerts missing an `environment` label, a stable `fingerprint`, or a valid
`startsAt` are **skipped** (the response reports `{ received, ingested, skipped }`).
Set an `environment` label on your alerting rules that **matches the environment
you declared on the deploy stage**. No external relay is needed.

## Point your tool here

Configure a webhook / notification integration that fires on incident **open** and
**resolve**, targeting the endpoint with the `reporting:ingest` bearer token. Map
your tool's fields to the contract:

- **Alertmanager** — use the [native adapter](#alertmanager-adapter-native) above (no field mapping needed beyond the `environment`/`severity` labels).
- **PagerDuty** — an [Events/Webhook v3 subscription](https://developer.pagerduty.com/docs/webhooks/v3-overview/) to `POST /api/reports/incidents`: map `incident.id` → `incidentId`, `incident.created_at` → `openedAt`, `incident.resolved_at` → `resolvedAt`, `incident.urgency`/priority → `severity`. Set `environment` from the affected service. (PagerDuty webhooks support custom payload templates, so the generic contract is the mapping target — no native parser needed.)
- **Datadog** — a [webhook notification](https://docs.datadoghq.com/integrations/webhooks/) on your monitor to `POST /api/reports/incidents`: template `$ALERT_ID` → `incidentId`, `$LAST_UPDATED`/`$DATE` → `openedAt`/`resolvedAt`, `$ALERT_STATUS` to decide whether `resolvedAt` is sent, and tag your monitor with the environment.
- **Opsgenie / others** — any tool that can POST JSON works; map its stable alert id, timestamps, environment, and severity to the [generic contract](#contract).

## Admin UI

**Settings → Incident Reporting** (org-admin; gated on `advanced_reporting`) is the
self-serve setup surface. It shows:

- the webhook URLs (generic + the Alertmanager adapter path);
- the **generate/rotate** flow for the per-org `reporting:ingest` [token](#getting-a-token-self-serve) (shown once);
- **provider presets** (Alertmanager / PagerDuty / Datadog / generic) with copy-paste setup steps + the required `environment` mapping;
- the [per-org correlation window](#per-org-correlation-window) input;
- the **Retention** inputs (standard-event + DORA-source windows — see **[DORA Metrics → Retention](dora-metrics.md#retention)**);
- a **Send test incident** button (see below);
- the **recent incidents** list.

### Test + list endpoints

```
POST /api/reports/incidents/test           # { "environment"?: "production" }
GET  /api/reports/incidents?limit=&offset=  # recent incidents + correlation, paginated
```

Both require `reports:read` + `advanced_reporting` (org-admin surfaces).

- **Test** is a **non-persisting dry-run**: it reports whether a synthetic incident
  opening *now* for `environment` would correlate to a recent successful deploy
  under the org's window — a wiring/config check that **does not write an incident
  or affect metrics**. Returns `{ environment, openedAt, windowHours, correlated,
  executionId, deployCompletedAt }`.
- **List** returns recent incidents newest-first, each with its `resolved` state and
  its correlated deploy (`correlatedExecutionId` / `deployCompletedAt`, or `null`).

## Related

- [DORA Metrics](dora-metrics.md) — how CFR + MTTR consume incidents
- [Post-deploy outcomes](dora-metrics.md#post-deploy-outcomes) — the manual mark-failed/restored path (deduped against incidents)
- [Onboarding](onboarding.md) — creating + storing the `reporting:ingest` service token
- [Roles & Permissions](permissions.md) — the `reporting:ingest` scope
