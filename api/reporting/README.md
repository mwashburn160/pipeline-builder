# Reporting Service

Analytics and reporting for pipeline executions and plugin inventory. Ingests CI/CD lifecycle events (AWS CodePipeline, CodeBuild, and plugin builds) and serves aggregated, per-organization dashboards.

## Features

- **Event ingestion** — Batch-ingest pipeline, stage, action, and build lifecycle events from a Lambda service account
- **Execution analytics** — Per-pipeline counts, success rate over time, duration percentiles (incl. p95), and stage/action failure breakdowns
- **Plugin analytics** — Inventory summary, type/compute distribution, version counts, and build success/duration/failure metrics
- **Multi-tenant isolation** — All report queries are scoped to the caller's `orgId` and enforced by row-level security
- **Two-tier caching** — Aggregations are cached in-memory to avoid repeated expensive SQL, with cache invalidated automatically after event ingest
- **Credential scrubbing** — Error and failure messages are redacted of credential-shaped substrings before they leave the service

## Endpoints

### Event Ingest (auth, no org)

Authenticated via a Lambda service account; no `orgId` is required because the producer delivers events across all tenants.

- `POST /reports/events` — Batch-ingest lifecycle events. Each event's `pipelineArn` is resolved against the pipeline registry; events for unregistered ARNs are dropped (and logged at WARN with sample ARNs). Returns `{ inserted, skipped, total }`.

Events are validated with a Zod discriminated union on `eventSource`, so the `status` enum is enforced per-producer: `codepipeline`/`codebuild` use uppercase AWS statuses (`SUCCEEDED`, `FAILED`, ...), while `plugin-build` uses lowercase BullMQ states (`completed`, `failed`, ...). Pipelines must first register via `POST /pipelines/registry` for their events to be retained.

### Execution Reports (auth + org)

- `GET /reports/execution/count` — Execution count per pipeline with status breakdown
- `GET /reports/execution/success-rate` — Success rate over time (`interval`: `day`, `week`, `month`)
- `GET /reports/execution/duration` — Average/min/max/p95 duration per pipeline
- `GET /reports/execution/stage-failures` — Stage failure heatmap
- `GET /reports/execution/stage-bottlenecks` — Slowest stages per pipeline
- `GET /reports/execution/action-failures` — Action (plugin step) failure rates
- `GET /reports/execution/errors` — Grouped error patterns (system admin only; messages scrubbed)

### Plugin Reports (auth + org)

- `GET /reports/plugins/summary` — Total/active/inactive/public/private/unique-name counts
- `GET /reports/plugins/distribution` — Plugin type × compute type distribution
- `GET /reports/plugins/versions` — Version counts per plugin name
- `GET /reports/plugins/build-success-rate` — Build success rate over time (`interval`: `day`, `week`, `month`)
- `GET /reports/plugins/build-duration` — Average/max build duration per plugin
- `GET /reports/plugins/build-failures` — Top build error messages (system admin only; messages scrubbed)

## Query Parameters

Time-ranged endpoints accept `from`/`to` query parameters. The range is capped at 365 days. The `interval` parameter (where supported) must be one of `day`, `week`, or `month` — it is validated at the route layer before reaching the query, since it is interpolated into `DATE_TRUNC` as raw SQL. Admin error/failure endpoints accept a `limit` (default 20, max 1000).

## Caching

Reports are served from a two-tier in-memory cache, keyed per org:

| Tier | Contents | Default TTL |
|------|----------|-------------|
| Inventory | Plugin summary, distribution, versions | 5 min (`CACHE_TTL_REPORT_INVENTORY`) |
| Timeseries | Execution and build metrics with date ranges | 2 min (`CACHE_TTL_REPORT_TIMESERIES`) |

After event ingest, the caches for affected orgs are invalidated post-commit (fire-and-forget); a missed invalidation self-heals within the TTL window.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `CACHE_TTL_REPORT_INVENTORY` | `300` | Inventory report cache TTL (seconds) |
| `CACHE_TTL_REPORT_TIMESERIES` | `120` | Timeseries report cache TTL (seconds) |
| `MAX_EVENTS_PER_BATCH` | `100` | Maximum events accepted per `POST /reports/events` request |
