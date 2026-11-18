# reporting

Analytics and reporting for pipeline executions, plugin builds and DORA, plus the Stakeholder Reports add-on (saved, scheduled, published reports). Ingests CI/CD lifecycle events and incidents, and serves per-organization dashboards. The API gateway (nginx) routes `/api/reports/*`, `/api/public/reports/*` and `/api/public/report-recipients/*` here.

## Responsibilities

- Batch-ingests pipeline, stage, action and plugin-build lifecycle events from machine credentials carrying the `reporting:ingest` token scope. The org is resolved from the pipeline registry, never from the request. Events for unregistered pipeline ids, for pipelines outside the caller's org subtree, or with impossible timestamps are dropped and counted. Re-deliveries are deduped.
- Ingests production incidents (generic JSON and a native Alertmanager adapter) and per-org forwarder health, both on the same ingest scope.
- Serves execution analytics, DORA (`advanced_reporting`), build health, and plugin inventory/build/runtime analytics. Every report query is scoped to the caller's org, plus its descendant teams only for `?includeDescendants=true` callers holding `reports:rollup`.
- Bounds every per-org report range by the account root's effective retention (billing-synced), and runs a leader-locked retention purge over the raw source rows.
- Stakeholder Reports: definitions, runs (frozen snapshots), publishing, share links, a distribution list with double opt-in, AI-drafted executive summaries, PDF rendering in a short-lived Chromium, and a leader-locked scheduler that re-checks the owner's authority on every run.
- Pushes an `execution-updated` SSE frame to each org whose execution state changed on ingest.

## Endpoints

| Prefix | Auth | Purpose |
|--------|------|---------|
| `/reports/events` | `reporting:ingest` scope | `POST /` batch ingest (returns `{ inserted, skipped, total }`); `GET /last-deploy-commit` (forwarder cold-start recovery) |
| `/reports/ingest-health` | `POST`: ingest scope · `GET`: `reports:read` | Forwarder heartbeat / the Reports freshness indicator |
| `/reports/incidents` | `POST /`, `POST /alertmanager`: ingest scope · `GET /`, `POST /test`: `reports:read` + `advanced_reporting` | Incident webhooks, recent incidents, wiring-test dry-run |
| `/reports/execution` | `reports:read` | `count`, `list`, `success-rate`, `duration`, `stage-failures`, `stage-bottlenecks`, `action-failures`, `build-health`; `dora`, `dora/trend`, `environments` (+ `advanced_reporting`); `errors` (system-org `orgs:read`, scrubbed); `stream/ticket` + `stream` (live SSE channel) |
| `/reports/plugins` | `reports:read` | `summary`, `distribution`, `versions`, `build-success-rate`, `build-duration`, `runtime-success-rate`, `runtime-duration`; `build-failures` (system-org `orgs:read`, scrubbed) |
| `/reports/retention` | `reports:read` | The org's effective retention horizon |
| `/reports/settings/incidents` | `reports:read` + `advanced_reporting` (`PUT` adds `org_settings:write`) | Incident→deploy correlation window |
| `/reports/deployments/:executionId/outcome` | `pipelines:write` + `advanced_reporting` | Mark a deployment failed / restored |
| `/reports/stakeholder/*` | `stakeholder_reports` feature + `reports:read` / `reports:write` / `reports:publish` per route; `PUT /policy` needs `org_settings:write` | Definitions, runs, notes, summary, publish, redeliver, PDF, share links, recipients, policy, delivery status |
| `/reports/stakeholder-preview` | `reports:write` (`GET`: `reports:read`) | The one-off watermarked preview for orgs without the add-on |
| `/reports/internal/retention-sync/:orgId` | internal, `billing` only | Billing pushes / reads the root org's retention |
| `/reports/internal/stakeholder-sync/:orgId` | internal, `billing` only | Pause / resume an account's reports on add-on loss / regain |
| `/reports/internal/stakeholder/owner-left/:orgId/:userId` | internal, `platform` only | Pause the reports a departed member owns |
| `/public/*` | the token in the request | Shared report (`/reports/:token`, `/reports/:token/pdf`), recipient `verify` and `unsubscribe` |

Everything under `/reports/internal/*` is service-to-service only (a named caller's service token; no user token is admitted), and the gateway refuses `/api/reports/internal/*` from outside (404).

Time-ranged report endpoints accept `from`/`to`; the operator error/failure endpoints accept `limit`.

## Configuration

| Variable | Purpose | Default |
|----------|---------|---------|
| `PORT` | HTTP listen port | `3000` |
| `CACHE_TTL_REPORT_INVENTORY_SECONDS` | Inventory report cache TTL (seconds) | `300` |
| `CACHE_TTL_REPORT_TIMESERIES_SECONDS` | Timeseries report cache TTL (seconds) | `120` |
| `MAX_EVENTS_PER_BATCH` | Max events accepted per `POST /reports/events` | `100` |
| `REPORTING_HTTP_TIMEOUT_MS` | Timeout (ms) for reporting's outbound service calls | `3000` |
| `PLATFORM_FRONTEND_URL` / `PLATFORM_BASE_URL` | Base URL for share, unsubscribe and confirmation links | `https://localhost:8443` |
| `REPORTING_RETENTION_ENABLED` | Retention purge kill switch (also off when billing is disabled) | `true` |
| `REPORTING_RETENTION_INTERVAL_HOURS` / `_BATCH_SIZE` / `_MAX_BATCHES` | Purge cadence and batching | `12` / `1000` / `50` |
| `REPORT_SCHEDULER_ENABLED` | Stakeholder-report scheduler kill switch | `true` |
| `REPORT_SCHEDULER_INTERVAL_MS` / `_BATCH` / `_CONCURRENCY` | Scheduler cadence, definitions per cycle, composes in flight | `300000` / `25` / `3` |
| `REPORT_RUN_TIMEOUT_MS` | Per scheduled run | `120000` |
| `REPORT_SETTLE_HOURS` / `REPORT_JITTER_MS` / `REPORT_CATCHUP_MAX` | Delay after a period ends, per-definition jitter, missed periods per run | `6` / `1800000` / `4` |
| `REPORT_PDF_ENABLED` / `REPORT_PDF_CHROMIUM_PATH` | PDF rendering switch and Chromium binary | `true` / `/usr/bin/chromium-browser` |
| `REPORT_PDF_TIMEOUT_MS` / `_CONCURRENCY` / `_QUEUE` / `_QUEUE_WAIT_MS` / `_HEAP_MB` / `_SCRATCH_DIR` | Render caps and scratch directory | `20000` / `1` / `4` / `5000` / `256` / `/tmp/report-pdf` |

`CACHE_TTL_*` and `MAX_EVENTS_PER_BATCH` are read by `@pipeline-builder/pipeline-core` (`CoreConstants`); Postgres, Redis, JWT and service-discovery settings come from the shared core packages.

## Development

Builds on the shared core packages (`@pipeline-builder/api-core`, `@pipeline-builder/api-server`, `@pipeline-builder/pipeline-core`, `@pipeline-builder/pipeline-data`). Project files are generated by projen from `.projenrc.ts`.

```sh
pnpm build   # compile + lint + test
pnpm test    # run tests
pnpm start   # run the compiled service (node lib/index.js)
```

## License

Apache-2.0
