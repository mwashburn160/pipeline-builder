# Plugin Service

Plugin registry and build API. Provides CRUD operations for plugin definitions, ZIP-based plugin uploads with asynchronous Docker image builds, bulk operations, AI-powered plugin generation from natural language, and operator tooling for the build queue. Plugins are reusable CI/CD build steps that run inside a Docker image on AWS CodeBuild (or as a `ShellStep`/`ManualApprovalStep`), with org-scoped, multi-tenant access control throughout.

## Endpoints

### Plugin CRUD

| Method | Path | Description |
|--------|------|-------------|
| GET | `/plugins` | List plugins (paginated, filtered, sortable) |
| GET | `/plugins/find` | Find a single plugin by filter (query string) |
| POST | `/plugins/lookup` | Find a single plugin by filter (request body) |
| GET | `/plugins/:id` | Get a plugin by UUID |
| GET | `/plugins/plugin-usage` | Count pipelines referencing each plugin (powers the "Used by N pipelines" badge) |
| POST | `/plugins` | Upload a plugin ZIP and queue its build |
| PUT | `/plugins/:id` | Update a plugin |
| DELETE | `/plugins/:id` | Soft-delete a plugin |

### Bulk Operations

Gated by the `bulk_operations` feature flag. Capped at `MAX_BULK_ITEMS` per request.

| Method | Path | Description |
|--------|------|-------------|
| POST | `/plugins/bulk/delete` | Soft-delete multiple plugins by ID |
| PUT | `/plugins/bulk/update` | Update multiple plugins with the same whitelisted fields |

Bulk update accepts only a safe field whitelist (`isActive`, `isDefault`, `category`, `description`, `keywords`, `accessModifier`) — tenancy boundaries (`orgId`), immutable fields, and registry-path fields (`name`, `version`) cannot be changed in bulk.

### AI Generation

Gated by the `ai_generation` feature flag. AI calls consume the org's `aiCalls` quota, reserved atomically and rolled back on provider failure.

| Method | Path | Description |
|--------|------|-------------|
| GET | `/plugins/providers` | List configured AI providers |
| POST | `/plugins/generate` | Generate a plugin config + Dockerfile from a prompt |
| POST | `/plugins/generate/stream` | Stream plugin generation as SSE |
| POST | `/plugins/deploy-generated` | Build and deploy an AI-generated plugin (admin only) |

Generation produces a structured plugin configuration (name, version, plugin type, compute size, install/build commands, keywords, optional env) plus a complete Dockerfile for the build environment. `/generate/stream` emits `partial` events as the model produces output and a final `done` event with the validated result.

### Queue Operations

Administrative endpoints for the build queue (admin/owner role required; org admins see only their own org's jobs, system admins see all).

| Method | Path | Description |
|--------|------|-------------|
| GET | `/plugins/queue/status` | Aggregate job counts across all tier queues + DLQ (with per-tier breakdown) |
| GET | `/plugins/queue/failed` | List recent failed build jobs |
| GET | `/plugins/queue/dlq` | List dead-letter queue jobs |
| DELETE | `/plugins/queue/dlq` | Purge the dead-letter queue (system admin only) |
| POST | `/plugins/queue/dlq/:jobId/replay` | Re-enqueue a single DLQ job with fresh retry counters |
| GET | `/plugins/queue/triage` | Failed-build summary grouped by failure category, with representative samples |

## Upload & Build Flow

`POST /plugins` accepts a multipart ZIP archive containing `plugin-spec.yaml` and (for image builds) a `Dockerfile`. The upload route runs `multer → auth → plugins quota` and is registered before other `/plugins` routes so its middleware sees the multipart body intact.

1. The ZIP is parsed and the plugin spec is validated.
2. The plugin is checked against the org's compliance rules. This is **fail-closed**: if the compliance service is unreachable, the upload is rejected (HTTP 503).
3. The `plugins` quota slot is reserved atomically; it is released on any failure path (validation error, compliance block, build exhaustion).
4. The build is dispatched based on its `buildType`:
   - **`metadata_only`** — no Docker build; the plugin record is persisted immediately (HTTP 201).
   - **`build_image`** — a Docker image is built from the Dockerfile and pushed to the registry (queued, HTTP 202).
   - **`prebuilt`** — a pre-built `image.tar` shipped in the ZIP is loaded and pushed (queued, HTTP 202).

Image builds run asynchronously on a [BullMQ](https://docs.bullmq.io/) worker; progress and completion are streamed to the client over SSE. `accessModifier` defaults to `private`; only admins/owners may publish a `public` plugin.

## Build Queue

The build worker is built for fair, resilient multi-tenant scheduling:

- **Per-tier queues** — one BullMQ queue + worker per quota tier (`developer`, `pro`, `unlimited`), so a burst on one tier can't starve another. The `developer` tier reuses the base queue name for backward compatibility.
- **Per-org concurrency cap** — a Redis Lua semaphore bounds in-flight builds per org (`PLUGIN_MAX_BUILDS_PER_ORG`, default 3); over the cap, jobs re-enqueue with a short backoff so another org can take the worker slot. A periodic scrubber reclaims slots leaked by crashed workers.
- **Dead-letter queue with replay** — retryable failures move to a DLQ and are automatically re-queued until a total attempt budget is exhausted; permanent failures (schema errors, compliance/validation violations, missing tarball) terminate immediately and refund the quota slot. Operators can inspect, replay, or purge the DLQ.
- **Tenant isolation** — non-system admins only ever see and act on their own org's queued, failed, and DLQ jobs.
- **Observability** — Prometheus counters and histograms (`plugin_builds_total`, `plugin_build_duration_seconds`, `plugin_job_wait_seconds`) are emitted per build, and `plugin.build.*` events are written to the audit log and pipeline event stream.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PLUGIN_UPLOAD_DIR` | `/opt/pipeline/pipeline-data/plugins-data/uploads` | Writable destination for uploaded ZIPs |
| `PLUGIN_UPLOAD_TIMEOUT_MS` | `300000` | Upload request timeout (ms) for large ZIPs |
| `PLUGIN_MAX_UPLOAD_MB` | `4096` | Maximum upload size (MB) |
| `PLUGIN_MAX_BUILDS_PER_ORG` | `3` | Max concurrent in-flight builds per org |
| `PLUGIN_ORG_SLOT_DELAY_MS` | `10000` | Backoff between org-slot re-acquisition attempts (ms) |
| `PLUGIN_ORG_SLOT_TTL_SEC` | `900` | Defensive expiry for org build slots (s) |
| `PLUGIN_TIER_CACHE_TTL_MS` | `300000` | TTL for the per-org tier lookup cache (ms) |
| `PLUGIN_BUILD_CONCURRENCY_DEVELOPER` / `_PRO` / `_UNLIMITED` | (build config default) | Per-tier worker concurrency |
| `PLUGIN_BUILD_QUEUE_NAME` | `plugin-build` | Base BullMQ queue name |
| `REDIS_DB_DEVELOPER` / `_PRO` / `_UNLIMITED` | `0` | Per-tier Redis DB partition (0–15) |

## Services

- **PluginService** — CRUD and versioned deployment via the `CrudService` base class
- **AI Plugin Generation Service** — Vercel AI SDK integration producing structured plugin config + Dockerfile (blocking and streaming)
- **Plugin Build Queue** — per-tier BullMQ workers, per-org concurrency control, DLQ, and replay

See [`openapi.yaml`](./openapi.yaml) for the full request/response schema.
