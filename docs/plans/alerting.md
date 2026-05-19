# Plan: Alerting + notification rules

## Goal

Operators get notified when critical thresholds breach (build failure rate
spikes, queue stalls, registry errors) without having to watch a dashboard.

## Recommendation

**Adopt Prometheus Alertmanager** rather than build a native alert system.
Reasoning:

- Prometheus is already deployed; Alertmanager is the standard companion
- Rule syntax is the same PromQL we use in the catalog
- Alertmanager handles routing (Slack/email/PagerDuty), deduplication,
  silencing, escalation — all out-of-band concerns we'd otherwise build
- A native alert system would need persistence, scheduler, retry,
  notification adapters — ~2000+ LoC for parity with Alertmanager's table-stakes
- Cost: one more service to deploy + monitor

The native UI surface is then a **read-only alerts page** that shows
current firing alerts + their status, fed by Alertmanager's API.

## Scope (4 PRs)

### PR-A1: Deploy Alertmanager + wire to Prometheus
- Add `alertmanager` service to local/minikube/ec2 docker-compose + k8s
- Configure Prometheus to forward alerts to it (`alerting.alertmanagers`)
- Network policy: `prometheus → alertmanager:9093`
- Empty rules file as the baseline — no alerts firing yet
- **~150 LoC**, all deploy + config

### PR-A2: First rules + Slack receiver
- `deploy/<target>/config/prometheus/alert-rules.yml` with 5 initial rules:
  - `PluginBuildFailureRateHigh` — fires when `plugin_build_success_rate_5m < 0.9` for 10 min
  - `PluginQueueStalled` — fires when `plugin_queue_jobs{state="waiting"} > 50` for 15 min
  - `PluginQueueProcessingSlow` — fires when `plugin_job_wait_p95 > 300` (5 min wait at p95) for 10 min
  - `DLQFilling` — fires when `plugin_dlq_size > 10`
  - `RegistryErrorBurst` — fires when registry 5xx rate > 0 for 5 min (needs new `registry_http_errors_total` counter)
- Alertmanager receiver config for Slack via `SLACK_WEBHOOK_URL` env var
- **~250 LoC**, mostly config + 1 new image-registry metric

### PR-A3: Frontend "Alerts" surface
- New page `/dashboard/observability/alerts` — read-only table of currently-firing alerts
- New backend endpoint `GET /api/observability/alerts` — proxies Alertmanager's `/api/v2/alerts`, returns shape `{ alerts: [{name, severity, summary, since, labels}] }`
- New sidebar entry under Observability section
- Alertmanager API requires no auth in-cluster; the platform proxy adds the same `requireAuth + $ORG` scoping (org admins see only alerts whose labels include their org_id; sysadmins see all)
- **~300 LoC** (page + endpoint + tests)

### PR-A4: Per-org alert rules + silencing UI
- DB table `alert_silences(id, org_id, label_matchers, reason, expires_at)`
- Backend: forward silences to Alertmanager's `/api/v2/silences` API
- Frontend: silence button on each alert row, modal to capture reason + duration
- **~400 LoC**

## Non-goals

- Replacing Alertmanager (custom routing engine, dedupe, escalation)
- Native PagerDuty integration (PD has good Alertmanager integration already)
- Alert authoring UI (rules edit happens in git — Alertmanager reloads on file change)
- Multi-Prometheus federation
- Historical alert browse / postmortem reporting

## Open questions

1. **Multi-org alert isolation**: each rule fires globally. Do we add an `org_id` label to all our metrics and require alerts to also be org-scoped, or accept that the initial alerts are platform-wide (sysadmin-only-visible)?
2. **Notification channels**: Slack only for v1, or also email at the start?
3. **PagerDuty**: needed in v1, or follow-up?

## Size estimate

| PR | LoC |
|---|---|
| A1 — Alertmanager deploy | 150 |
| A2 — Rules + Slack | 250 |
| A3 — Alerts page | 300 |
| A4 — Silences | 400 |
| **Total** | **~1100 LoC** across 4 PRs over ~2 weeks |
