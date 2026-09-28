---
layout: default
title: Incident Webhook
image: /assets/og-image-solution.png
---

<!--
Copyright 2026 Pipeline Builder Contributors
SPDX-License-Identifier: Apache-2.0
-->

# Incident Webhook

Point your existing incident tooling at the platform once, and two [DORA metrics](dora-metrics.md) fill themselves in.

## Highlights

- **Two metrics become automatic.** A production incident correlated to a deploy makes that deploy a **post-deploy failure** (CFR); a resolved incident supplies the **real** recovery time (MTTR), not a hand-marked one.
- **The org comes from the token, never the body.** A token can only ever file incidents for its own organization.
- **The webhook token is least-privilege by construction.** The `reporting:ingest` scope forces `role=member` with no features or permissions, so even an admin's webhook token can only file incidents.
- **Idempotent on `(org, incidentId)`.** The normal flow is two POSTs — open, then resolve — and retries or at-least-once deliveries are safe.
- **Alertmanager has a native adapter.** It posts a batched payload, so there is a second route that reshapes the batch into one incident per alert. No external relay needed.
- **An incident with no eligible deploy in the window is not attributed** — it contributes nothing to CFR or MTTR, because it can't be blamed on a specific deploy.
- **The test button is a dry-run.** It checks your wiring without writing an incident or moving a metric.
- **`environment` must match the deploy stage.** This is the single most common wiring mistake.

## Overview

The incident webhook turns PagerDuty, Datadog, Opsgenie, in-cluster Alertmanager — or any system that can POST JSON — into an automated source of Change Failure Rate and Mean Time To Restore.

| Metric | What an incident supplies |
|---|---|
| **Change Failure Rate (CFR)** | A production incident correlated to a deploy makes that deploy a **post-deploy failure**. |
| **Mean Time To Restore (MTTR)** | A resolved incident gives the **real** recovery time (`resolved_at − opened_at`). |

The manual [post-deploy outcomes](dora-metrics.md#post-deploy-outcomes) path still works and is deduped against incidents, so you can stop clicking **Mark failed / Mark restored** without losing what you already marked.

> Incident data only surfaces through DORA, which is an **`advanced_reporting`** feature (Enterprise, or the [Advanced Reporting add-on](billing-bundles.md)). Ingesting incidents without the entitlement is harmless — they are stored but never shown.

## How it works

1. **Your tool POSTs an incident** to `/api/reports/incidents` with a `reporting:ingest` bearer token, on incident **open**.
2. **The org is resolved from the token identity.** The request body cannot name an organization.
3. **The incident is upserted on `(org, incidentId)`.** A second POST with the same id updates it in place rather than creating a duplicate.
4. **Your tool POSTs again on resolve**, same `incidentId`, now carrying `resolvedAt`.
5. **Correlation runs.** The incident is attributed to the most recent successful deploy to its `environment` whose `completed_at ≤ openedAt`, within the correlation window.
6. **DORA reads it.** That deploy becomes a post-deploy failure, and a resolved incident supplies the MTTR gap.

## Configuration

### 1. Mint a token

The webhook token is an **access key scoped to `reporting:ingest`** — org-bound and least-privilege.

**Admin UI (recommended)** — **Settings → Incident Reporting → Webhook token → Generate webhook token**.

It asks you to re-confirm your identity, either with your password or a fresh sign-in with your provider ([step-up](authentication.md#step-up-re-authentication-every-account)), and shows the key **once**. Copy it immediately — only its hash is stored.

*To rotate:* generate a new one and revoke the old key on the **Security → Access keys** settings page. The old one stops working within five minutes.

Under the hood this is `POST /api/user/keys` with `{ scope: "reporting:ingest" }`.

**CLI** — for the in-AWS-account event forwarder credential, which is a [service-account key](authentication.md#stored-machine-credentials-aws) stored in Secrets Manager with daily rotation:

```bash
pipeline-manager infra store-token --scope reporting:ingest
```

See [Onboarding → store the service-account keys](onboarding.md).

### 2. Set the correlation window, if the default doesn't fit

The window defaults to `DORA_INCIDENT_WINDOW_HOURS` (24) on the reporting service, and an org admin can override it per-org (1–720 hours) in the [Admin UI](#admin-ui) or via the endpoint — see [Per-org correlation window](#per-org-correlation-window).

### 3. Point your tool at the endpoint

Configure a webhook or notification integration that fires on incident **open** and **resolve**. See [Point your tool here](#point-your-tool-here) for per-vendor walkthroughs.

**Set an `environment` that matches the environment you declared on the deploy stage.** This is what correlation joins on.

### 4. Verify before relying on it

Use **Send test incident** in the Admin UI, or `POST /api/reports/incidents/test`. It is a non-persisting dry-run, so it proves the wiring without writing anything.

## Authentication

The endpoint is a **machine** endpoint, authorized by the **`reporting:ingest`** token scope — the same org-scoped credential the event forwarder holds. The org is taken from the **token identity**, never from the request body, so a token can only file incidents for its own organization.

Send the token as a bearer credential:

```
Authorization: Bearer <reporting:ingest-scoped token>
```

### Getting a token (self-serve)

See [Configuration step 1](#1-mint-a-token) above for both the Admin UI and CLI paths.

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

Response: `200` with `{ "data": { "incidentId": "PD-4821", "ok": true } }`.

| Failure | Response |
|---|---|
| Validation failure | `400 VALIDATION_ERROR` |
| Token without the `reporting:ingest` scope | `403` |

## Idempotency

Incidents are keyed on **`(org, incidentId)`**. Posting the same `incidentId` again is an **upsert**, not a duplicate. The typical flow is two POSTs:

1. **On open** — `openedAt` set, `resolvedAt` omitted.
2. **On resolve** — the same `incidentId` with `resolvedAt` now populated.

The resolve POST updates `resolvedAt`, and any other changed fields, in place. Retries and at-least-once webhook deliveries are therefore safe.

## Correlation window

Each incident is attributed to the **most recent successful deploy** to its `environment` whose `completed_at ≤ openedAt`, **within `DORA_INCIDENT_WINDOW_HOURS`** (default **24**, configurable on the reporting service). That deploy becomes a post-deploy failure and, if the incident resolves, supplies the MTTR gap.

- An incident with **no** eligible deploy in the window is **not** attributed, and contributes nothing to CFR or MTTR — it can't be blamed on a specific deploy.
- The window boundary is **inclusive**: exactly 24h correlates, one second past does not.
- **Dedup.** If a deploy is flagged by **both** an incident and a manual `failed` outcome, it counts as **one** post-deploy failure, and the **incident takes precedence** for MTTR.

### Per-org correlation window

An org admin can override the window per-org (1–720 hours), in the [Admin UI](#admin-ui) or via the endpoint:

```
GET  /api/reports/settings/incidents      # read { incidentWindowHours, defaultWindowHours,
                                          #        eventRetentionDays, doraRetentionDays,
                                          #        defaultEventRetentionDays, defaultDoraRetentionDays }
PUT  /api/reports/settings/incidents      # any subset of { "incidentWindowHours": 12,
                                          #   "eventRetentionDays": 45, "doraRetentionDays": 200 }
```

Both require `reports:read` + `advanced_reporting`; the **PUT additionally requires the org-admin `org:settings`** permission.

The PUT is a **partial** upsert — send any subset, and omitted fields are left unchanged. When set, the correlation-window override is used everywhere the correlation runs: DORA CFR/MTTR, the incidents list, and the test dry-run. When unset, the env default applies.

The same endpoint carries the two **retention** overrides (`eventRetentionDays` / `doraRetentionDays`, 1–730 days) — see [DORA Metrics → Retention](dora-metrics.md#retention).

## Alertmanager adapter (native)

In-cluster Prometheus **Alertmanager** posts a *batched* payload (`{status, alerts:[…]}`), a different shape from the generic contract. Point a [`webhook_config`](https://prometheus.io/docs/alerting/latest/configuration/#webhook_config) receiver at the **native adapter** instead, and it reshapes the batch into one incident per alert:

```
POST /api/reports/incidents/alertmanager
Authorization: Bearer <reporting:ingest token>
```

Mapping, per alert:

| Incident field | From |
|----------------|------|
| `incidentId` | alert `fingerprint` (falls back to the payload `groupKey`) |
| `environment` | the `environment` **label** (override the label name with `?environmentLabel=<label>`) |
| `severity` | the `severity` label (defaults to `unknown`) |
| `openedAt` | `startsAt` |
| `resolvedAt` | `endsAt`, only when the alert `status` is `resolved` (Alertmanager's "no end" zero value is ignored) |

Same `reporting:ingest` auth and idempotent `(org, incidentId)` upsert as the generic route.

Alerts missing an `environment` label, a stable `fingerprint`, or a valid `startsAt` are **skipped**, and the response reports `{ received, ingested, skipped }`. Set an `environment` label on your alerting rules that **matches the environment you declared on the deploy stage**.

## Point your tool here

Every walkthrough below sets `Authorization: Bearer <token>` and `Content-Type: application/json`, targeting `POST /api/reports/incidents` and mapping the tool's fields to the [contract](#contract).

### Alertmanager

Use the [native adapter](#alertmanager-adapter-native) — point a receiver's `webhook_configs.url` at the adapter path. No body mapping is needed beyond the `environment` and `severity` labels, and firing/resolved is taken from Alertmanager's own `status`.

### PagerDuty

1. **Integrations → Generic Webhooks (v3) → New Webhook**, or an [Events/Webhook v3 subscription](https://developer.pagerduty.com/docs/webhooks/v3-overview/).
2. **Webhook URL** = `<PLATFORM_BASE_URL>/api/reports/incidents`; add a **Custom Header** `Authorization: Bearer <token>`.
3. Subscribe to **`incident.triggered`** and **`incident.resolved`**.
4. Use a **custom payload template** to emit the contract: `incident.id` → `incidentId`, `incident.created_at` → `openedAt`, `incident.resolved_at` → `resolvedAt` (omit while open), `incident.priority` / `urgency` → `severity`, and a fixed or service-derived `environment`.

### Datadog

1. **Integrations → Webhooks → New** — set **URL** = `<PLATFORM_BASE_URL>/api/reports/incidents` and add the `Authorization: Bearer <token>` header.
2. Define the **Payload** with the contract fields using Datadog variables: `$ALERT_ID` → `incidentId`, `$DATE` / `$LAST_UPDATED` → `openedAt` / `resolvedAt`, and a literal `environment` or a tag template.
3. On each monitor that represents production health, add `@webhook-<name>` to the message, and send `resolvedAt` only when `$ALERT_TRANSITION` is a recovery. Tag the monitor with the environment.

### Opsgenie

1. **Settings → Integrations → Add → Webhook**.
2. **Webhook URL** = `<PLATFORM_BASE_URL>/api/reports/incidents`; add the `Authorization: Bearer <token>` header; enable **Add Alert Description to Payload** as needed.
3. Enable the **Alert Created** and **Alert Closed** notifications, and map the alert's stable id → `incidentId`, timestamps → `openedAt` / `resolvedAt`, priority → `severity`, plus an `environment`.

### Anything else

Any tool that can POST JSON works — map its stable alert id, open and resolve timestamps, environment and severity to the [generic contract](#contract), and send the bearer token. Use the [Send test incident](#test--list-endpoints) button to verify the wiring before relying on it.

## Admin UI

**Settings → Incident Reporting** (org-admin; gated on `advanced_reporting`) is the self-serve setup surface. It shows:

- the webhook URLs — generic plus the Alertmanager adapter path;
- the **generate/rotate** flow for the per-org `reporting:ingest` [token](#getting-a-token-self-serve), shown once;
- **provider presets** (Alertmanager / PagerDuty / Datadog / generic) with copy-paste setup steps and the required `environment` mapping;
- the [per-org correlation window](#per-org-correlation-window) input;
- the **Retention** inputs — standard-event and DORA-source windows; see [DORA Metrics → Retention](dora-metrics.md#retention);
- a **Send test incident** button;
- the **recent incidents** list.

### Test + list endpoints

```
POST /api/reports/incidents/test            # { "environment"?: "production" }
GET  /api/reports/incidents?limit=&offset=  # recent incidents + correlation, paginated
```

Both require `reports:read` + `advanced_reporting`, and are org-admin surfaces.

- **Test** is a **non-persisting dry-run**: it reports whether a synthetic incident opening *now* for `environment` would correlate to a recent successful deploy under the org's window. A wiring and config check that **does not write an incident or affect metrics**. Returns `{ environment, openedAt, windowHours, correlated, executionId, deployCompletedAt }`.
- **List** returns recent incidents newest-first, each with its `resolved` state and its correlated deploy (`correlatedExecutionId` / `deployCompletedAt`, or `null`).

## Related

- [DORA Metrics](dora-metrics.md) — how CFR and MTTR consume incidents
- [Post-deploy outcomes](dora-metrics.md#post-deploy-outcomes) — the manual mark-failed/restored path, deduped against incidents
- [Onboarding](onboarding.md) — creating and storing the `reporting:ingest` service token
- [Roles & Permissions](permissions.md) — how permissions differ from the machine-token scopes this endpoint uses
- [Billing Bundles](billing-bundles.md) — the Advanced Reporting add-on that surfaces this data
