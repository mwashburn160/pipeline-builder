# ops-center

The operations control plane of Pipeline Builder: the Prometheus / Loki / Alertmanager proxy behind the in-app dashboards and logs, the dashboards themselves, per-org alert rules and alert destinations, the Alertmanager relay, on-call paging, and the Alertmanager-driven storage and Postgres auto-scaling webhooks.

It was split out of `platform` (the identity hub) so that the service every user depends on to sign in holds no Kubernetes API rights, takes no Alertmanager webhook traffic and carries no upstream-proxy load. The external URL paths did not change: the API gateway (nginx) routes `/api/observability/*` and `/api/dashboards*` here (stripping `/api`), so the browser and the CLI call exactly what they called before.

## What moved here, and what stayed in platform

| Moved to ops-center | Stayed in platform |
|---|---|
| `/observability/*`: catalog query batch, logs (search, volume, context, raw, export), catalog, firing alerts, silences | Identity, sessions, orgs + teams, membership, Roles/RBAC, SSO/SAML/SCIM, JWT issuance + JWKS |
| `/observability/alert-destinations*`, `/observability/alert-rules*` (incl. `materialized.yml`) | The audit trail (Mongo) and its ingest — ops-center audits through `POST /audit/events` like every remote service |
| The Alertmanager relay (`/observability/alert-webhook`) and the in-app / Slack / webhook / email channels | The email relay (`POST /internal/notify-email`) — ops-center sends through it |
| On-call: `/observability/oncall-webhook`, `/oncall-ack`, `/oncall-status`, `/oncall-test`, the rota-coverage gauge, the alert-delivery posture gauges and the dead-man heartbeat | The platform business-metric scraper (`platform_users_total` & co. — Mongo counts) |
| `/observability/pvc-autoexpand`, `/postgres-rung`, `/node-disk-autoexpand` and the k8s RBAC Roles they need | The org-purge / user-erasure cascade outbox (it now has an `ops-center` leg) |
| `/dashboards*` and the default-dashboard seeder | `support_contacts` (its only Postgres table) |
| The soft-delete retention purge of dashboards / alert rules / alert destinations | |
| The relay-bearer rotation probe (`ALERT_WEBHOOK_INSTANCE_TOKEN`) | The token-signing-key and at-rest-key rotation probes |

## Data

Postgres only — there is no MongoDB connection. The service owns (pipeline-data `ORG_DATA_OWNERSHIP['ops-center']`): `dashboards`, `dashboard_panels`, `org_alert_rules`, `org_alert_destinations` (soft-deleted, retention-purged) and `alert_destination_status` (per-destination delivery health, hard-deleted). `alert_destination_status` was a MongoDB collection with a 30-day TTL index while this code lived in platform; it is a Postgres table now, and a leader-locked sweep removes rows nothing has tried to reach for 30 days. An org purge reaches all of them through the cascade outbox's `ops-center` leg (`POST /ops/internal/orgs/:orgId/purge`, idempotent).

## What it asks platform for

Every read of platform-held identity data is a typed internal contract (api-core `PLATFORM_INTERNAL`, caller `ops-center`, `services/platform-client.ts`):

| Contract | Why |
|---|---|
| `orgAccountRoot` — `GET /internal/ops/org-account-root/:orgId` | Feature quotas (dashboards, alertRules, alertDestinations) reserve against the account root; the org hierarchy is platform's Mongo |
| `auditActivity` — `POST /internal/ops/audit-activity` | The Audit Activity panels aggregate platform's audit trail, scoped to the caller identity ops-center verified |
| `liveOrgIds` — `GET /internal/ops/live-org-ids` | A sysadmin's `orgs=all` log view enumerates the live orgs (Loki has no tenant wildcard) |
| `notifyEmail` (`alert` leg) | Email alert destinations — one configured address per send |
| `notifyEmail` (tenant leg) | The "your destination keeps failing" notice to the org's admins (platform resolves the recipients) |
| `notifyEmailStatus` | Whether the deployment can send email (cached; a disabled deploy reports email destinations as skipped) |

## Auth

api-core's stateless `requireAuth` (signature against platform's JWKS + the shared revocation store) and the same permission gates the routes had in platform (`observability:read` / `:write`, `dashboards:read` / `:write`, `logs:export`, system-org `platform:read` / `oncall:manage`, step-up on restore/purge). The machine webhooks authenticate inside the handler with the per-Alertmanager-instance bearer (`ALERT_WEBHOOK_INSTANCES`) or, for the PagerDuty ack, an HMAC over the raw body (`PAGERDUTY_WEBHOOK_SECRET`). The generated route table is [`frontend/src/generated/route-table/ops-center.json`](../../frontend/src/generated/route-table/ops-center.json) (rewritten by `UPDATE_ROUTE_TABLES=1` on `test/route-coverage.test.ts`); the reviewed authorization of each route is in [`docs/permission-contract.md`](../../docs/permission-contract.md).

## Configuration

The env var names are the ones platform read; they moved with the code (see `src/config/index.ts` and [`docs/environment-variables.md`](../../docs/environment-variables.md)).

| Variable | Purpose | Default |
|---|---|---|
| `PROMETHEUS_URL` / `LOKI_URL` / `ALERTMANAGER_URL` | Backends the proxy reads | `http://prometheus:9090` / `http://loki:3100` / `http://alertmanager:9093` |
| `LOKI_BASE_SELECTOR` | Anchor matcher for every LogQL selector | `service_name=~".+"` |
| `ALERTMANAGER_TIMEOUT_MS` / `ALERT_DELIVERY_TIMEOUT_MS` | Upstream / per-destination timeouts | `5000` / `5000` |
| `ALERT_EMAIL_DEDUPE_TTL_MS` | At-least-once dedupe window for alert email | `600000` |
| `ALERT_DESTINATION_MAX_LABEL` / `_MAX_TARGET`, `DASHBOARD_MAX_*` | Field caps | `100` / `2048`, see config |
| `ALERT_WEBHOOK_INSTANCES` | Per-Alertmanager-instance bearer tokens (JSON) for every machine webhook | unset → webhooks answer 503 |
| `LIMITER_MAX` / `_WINDOW_MS`, `OBSERVABILITY_LIMITER_*`, `ALERT_WEBHOOK_LIMITER_*` | Per-org general bucket, per-org observability bucket, relay burst bucket | `100`/15 min, `120`/1 min, `3000`/1 min |
| `PVC_AUTOEXPAND_*`, `POSTGRES_RUNG_*`, `PG_READ_REPLICA_MAX`, `NODE_DISK_AUTOEXPAND_*`, `AWS_REGION` | The auto-scaling webhooks (all OFF by default) | see config |
| `ONCALL_*`, `PAGERDUTY_*`, `SLACK_ALERTS_*` | On-call paging, the rota gauge, the dead-man heartbeat, delivery posture | see `docs/oncall-paging.md` |
| `PLATFORM_FRONTEND_URL` | Links in the failing-destination notice | `https://localhost:8443` |
| `PLATFORM_SERVICE_HOST` / `_PORT`, `QUOTA_SERVICE_HOST` / `_PORT` | Where platform and quota listen | `platform` / `quota`, `3000` |

Postgres, Redis, JWT, service-signing keys and OpenTelemetry settings come from the shared core packages, as for every api service.

## Development

Builds on `@pipeline-builder/api-core`, `@pipeline-builder/api-server`, `@pipeline-builder/pipeline-core` and `@pipeline-builder/pipeline-data`. Project files are generated by projen from `.projenrc.ts`.

```sh
pnpm build   # compile + lint + test
pnpm test    # run tests
pnpm start   # run the compiled service with the otel-bootstrap preload
```

## License

Apache-2.0
