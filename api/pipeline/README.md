# pipeline

Pipeline management microservice — CRUD for CI/CD pipeline configurations, bulk operations, a deployed-pipeline registry, and AI-powered pipeline generation from natural language or a Git repository.

## Responsibilities

- Org-scoped, multi-tenant CRUD over pipeline definitions, backed by Drizzle ORM and the `PipelineService` (extends the shared `CrudService`).
- Bulk create / update / delete (`bulk_operations` feature gate).
- A pipeline registry mapping each deployed pipeline (by stable `pipelineId`) to its owning org, used by dashboards and the `audit-stacks` CLI for event reporting and drift detection.
- AI generation of pipeline config from a prompt or a Git repo URL (`ai_generation` feature gate), with SSE-streaming variants and auto-creation of missing referenced plugins.
- Emits entity lifecycle events to the compliance service (as the `pipeline` service principal) for asynchronous re-validation.

Built on the shared core packages: `@pipeline-builder/api-core` (auth, quota, response helpers), `@pipeline-builder/api-server` (app factory, SSE, request context), `@pipeline-builder/pipeline-data` (Drizzle + `CrudService`), and `@pipeline-builder/pipeline-core` (config, migrations).

## Endpoints

The service listens on port `3000`. The API gateway (nginx) routes `/api/pipeline*` and `/api/pipelines*` here, rewriting to the internal `/pipelines/*` paths below.

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/pipelines` | List pipelines (paginated, filtered) |
| GET | `/pipelines/find` | Find a single pipeline by query filter |
| GET | `/pipelines/:id` | Get pipeline by ID |
| POST | `/pipelines` | Create a pipeline (consumes `pipelines` quota) |
| PUT | `/pipelines/:id` | Update a pipeline |
| DELETE | `/pipelines/:id` | Soft-delete a pipeline (admin-only) |
| POST | `/pipelines/bulk/create` | Bulk create (`bulk_operations` gate) |
| POST | `/pipelines/bulk/delete` | Bulk delete (`bulk_operations` gate) |
| PUT | `/pipelines/bulk/update` | Bulk update (`bulk_operations` gate) |
| GET | `/pipelines/registry` | List deployed-pipeline registry entries |
| POST | `/pipelines/registry` | Upsert a registry entry (keyed by `pipelineId`) |
| DELETE | `/pipelines/registry/:id` | Remove a registry entry |
| GET | `/pipelines/providers` | List available AI generation providers |
| POST | `/pipelines/generate` | Generate a pipeline from a prompt (`ai_generation` gate) |
| POST | `/pipelines/generate/stream` | Generate a pipeline (SSE stream) |
| POST | `/pipelines/generate/from-url/stream` | Analyze a Git repo URL and stream generation |

## Configuration

Shared server/auth/DB settings (`PORT`, `JWT_SECRET`, `DB_*`, `PLATFORM_BASE_URL`, CORS) are read via `@pipeline-builder/pipeline-core`, and AI provider keys via `@pipeline-builder/ai-core`. The only env var read directly by this service:

| Variable | Purpose | Default |
|----------|---------|---------|
| `PIPELINE_PLUGIN_SERVICE_TIMEOUT_MS` | Timeout for lookups against the plugin service during generation (ms) | `30000` |

## Development

```bash
pnpm build   # projen build (compile + test + package)
pnpm compile # tsc only
pnpm test    # jest
pnpm watch   # incremental compile
```

On startup the service runs any pending Drizzle migrations (`runMigrations()`) before opening the listening socket. CRUD and access control are centralized in `PipelineService`, which extends the shared `CrudService` for consistent multi-tenant queries and pagination.

## License

Apache-2.0
