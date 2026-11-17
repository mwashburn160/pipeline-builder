# plugin

Plugin registry and build microservice — CRUD for plugin definitions, ZIP uploads with asynchronous Docker image builds, bulk operations, AI-powered plugin generation, and operator tooling for the build queue.

## Responsibilities

- Org-scoped, multi-tenant CRUD over plugin definitions, backed by Drizzle ORM and the `PluginService` (extends the shared `CrudService`).
- ZIP-based plugin uploads (multer) that enqueue an asynchronous Docker image build on a BullMQ/Redis queue, with a per-org concurrency semaphore and tier-based limits.
- Build-queue operator tooling: status, failed jobs, dead-letter queue inspection/replay, and triage.
- Bulk update / delete (`bulk_operations` feature gate) and AI generation of plugins from a prompt (`ai_generation` feature gate, SSE streaming).
- Emits entity lifecycle events to the compliance service (as the `plugin` service principal) for asynchronous re-validation.

Built on the shared core packages: `@pipeline-builder/api-core` (auth, quota, response helpers), `@pipeline-builder/api-server` (app factory, SSE, request context), `@pipeline-builder/pipeline-data` (Drizzle + `CrudService`), and `@pipeline-builder/pipeline-core` (config). Requires Redis for the BullMQ build queue.

## Endpoints

The service listens on port `3000`. The API gateway (nginx) routes `/api/plugin*` and `/api/plugins*` here, rewriting to the internal `/plugins/*` paths below.

Every `/plugins` route sits behind auth + org context; reads need `plugins:read`, writes `plugins:write` unless noted.

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/plugins` | List plugins (paginated, filtered) |
| GET | `/plugins/find` | Find a single plugin by query filter |
| POST | `/plugins/lookup` | Find a single plugin by filter in the request body |
| GET | `/plugins/deleted` | List soft-deleted plugins (restorable) |
| GET | `/plugins/vuln-waivers` | List vulnerability waivers |
| GET | `/plugins/plugin-usage` | Count pipelines referencing each plugin |
| GET | `/plugins/:id` | Get a plugin by ID |
| GET | `/plugins/:id/sbom` | Get a plugin version's SBOM |
| GET | `/plugins/:id/findings` | Get a plugin version's vulnerability findings |
| POST | `/plugins` | Upload a plugin ZIP and queue its build (consumes `plugins` quota) |
| POST | `/plugins/inspect` | Validate a plugin ZIP without building it |
| PUT | `/plugins/:id` | Update a plugin |
| DELETE | `/plugins/:id` | Soft-delete a plugin version (refused while in use; `?force=true` + step-up for a listed version) |
| POST | `/plugins/:id/restore` | Restore a soft-deleted plugin |
| POST | `/plugins/:id/purge` | Permanently purge a soft-deleted plugin |
| POST | `/plugins/:id/deprecate` / `yank` / `unyank` | Version lifecycle |
| POST | `/plugins/bulk/delete` | Bulk delete (`bulk_operations` gate) |
| PUT | `/plugins/bulk/update` | Bulk update (`bulk_operations` gate) |
| GET | `/plugins/providers` | List available AI generation providers (`ai_generation` gate) |
| POST | `/plugins/generate` | Generate a plugin from a prompt (`ai_generation` gate) |
| POST | `/plugins/generate/stream` | Generate a plugin (SSE stream) |
| POST | `/plugins/deploy-generated` | Deploy an AI-generated plugin |
| GET | `/plugins/storage` | Per-version registry storage for the org |
| POST | `/plugins/storage/prune` | Retire one unreferenced version's image to reclaim storage |
| GET | `/plugins/queue/status` | Build-queue status (system org, `plugin_queue:manage`) |
| GET | `/plugins/queue/failed` | List failed build jobs (every org's for a system-org `plugin_queue:manage` holder with an aal2 session; the caller's own org's newest jobs for any other `plugins:write` holder) |
| POST | `/plugins/queue/failed/:jobId/retry` | Retry a failed build (same access as the list); `?tier=` picks the tier queue when the id is in several (else 409 `AMBIGUOUS_JOB_ID`) |
| GET | `/plugins/queue/dlq` | List dead-letter-queue jobs (same access as the failed list) |
| DELETE | `/plugins/queue/dlq` | Purge the dead-letter queue (system org, `plugin_queue:manage`) |
| POST | `/plugins/queue/dlq/:jobId/replay` | Replay a dead-letter job (same access as the failed list) |
| GET | `/plugins/queue/triage` | Build-queue triage view (same access as the failed list) |

Further route families, each with its own gates (see `src/app-routes.ts` for the mount order): the ecosystem (`/plugins/ecosystem`, publishers, installs, reviews), toolchain releases and org toolchain defaults, security notifications, pipeline security/exposures, retention and kept setup images, `/public/*` (the public directory, anonymous submissions, security-notification confirmation) and `/internal/*` (service-to-service).

## Configuration

Shared server/auth/DB/Redis settings (`PORT`, `DB_*`, `PLATFORM_BASE_URL`, CORS) are read via `@pipeline-builder/pipeline-core`, Redis (`REDIS_URL` or `REDIS_SENTINELS`, required for the build queue) via `@pipeline-builder/api-core`, and AI provider keys via `@pipeline-builder/ai-core`. Env vars read directly by this service:

| Variable | Purpose | Default |
|----------|---------|---------|
| `PLUGIN_UPLOAD_DIR` | Directory where uploaded ZIPs are staged for the build | `/opt/pipeline/pipeline-data/plugins-data` |
| `PLUGIN_UPLOAD_TIMEOUT_MS` | Upload request timeout (ms) | `900000` |
| `PLUGIN_ORG_BUILD_SLOTS_STANDARD` | BASELINE per-org build slots on the standard class; the tier ladder only raises it, and the system org is exempt | `5` |
| `PLUGIN_ORG_BUILD_SLOTS_FLEXIBLE` | Same baseline for the flexible class, higher so the cheap class keeps headroom on every tier | `8` |
| `PLUGIN_ORG_SLOT_DELAY_MS` | Delay before re-checking an org build slot (ms) | `10000` |
| `PLUGIN_ORG_SLOT_TTL_SECONDS` | Per-org slot TTL (s) | `900` |
| `PLUGIN_BUILD_CONCURRENCY_DEVELOPER` | Worker concurrency for the developer tier | (computed) |
| `PLUGIN_BUILD_CONCURRENCY_PRO` | Worker concurrency for the pro tier | (computed) |
| `PLUGIN_BUILD_CONCURRENCY_TEAM` | Worker concurrency for the team tier | (computed) |
| `PLUGIN_BUILD_CONCURRENCY_ENTERPRISE` | Worker concurrency for the enterprise tier | (computed) |
| `PLUGIN_TIER_CACHE_TTL_MS` | TTL for the per-org tier cache (ms) | `300000` |
| `PLUGIN_DLQ_SCAN_INTERVAL_MS` | Dead-letter-queue scan interval (ms) | `5000` |
| `PLUGIN_QUEUE_METRICS_INTERVAL_MS` | Queue metrics scrape interval (ms) | `15000` |
| `IMAGE_REGISTRY_TOKEN_REALM` | Token realm passed to buildkit | `${PLATFORM_BASE_URL}/image-registry/token` |

## Development

```bash
pnpm build   # projen build (compile + test + package)
pnpm compile # tsc only
pnpm test    # jest
pnpm watch   # incremental compile
```

The BullMQ worker starts with the server and is awaited ready before the listening socket opens. CRUD and access control are centralized in `PluginService`, which extends the shared `CrudService` for consistent multi-tenant queries and pagination.

## License

Apache-2.0
