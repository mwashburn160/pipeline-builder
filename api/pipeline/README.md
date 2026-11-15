# pipeline

Pipeline management microservice — CRUD for CI/CD pipeline configurations, bulk operations, a deployed-pipeline registry, and AI-powered pipeline generation from natural language or a Git repository.

## Responsibilities

- Org-scoped, multi-tenant CRUD over pipeline definitions, backed by Drizzle ORM and the `PipelineService` (extends the shared `CrudService`), with soft-delete, restore and purge.
- Pre-flight validation of a create (`POST /pipelines/validate`, what `pipeline create --dry-run` calls) that runs every create-time check and writes nothing.
- Bulk create / update / delete (`bulk_operations` feature gate).
- A pipeline registry mapping each deployed pipeline (by stable `pipelineId`) to its owning org, plus the synth's step manifest, used by event reporting, dashboards and the `audit stacks` CLI for drift detection. Execution start/stop goes through it to the registered CodePipeline.
- Plugin-version upgrades across pipelines (preview + apply), application-artifact security reports uploaded by a pipeline's scan steps, and per-pipeline / org-wide maturity scorecards (`advanced_reporting` gate).
- Golden-path pipeline templates: catalog, authoring, and instantiation into pipeline `props`.
- AI generation of pipeline config from a prompt or a Git repo URL (`ai_generation` feature gate), with SSE-streaming variants. Missing plugins a generated config references are only PROPOSED; placeholders are created by a separate, user-confirmed request.
- Emits entity lifecycle events (create, update, delete, restore) to the compliance service (as the `pipeline` service principal) for asynchronous re-validation.

Built on the shared core packages: `@pipeline-builder/api-core` (auth, quota, response helpers), `@pipeline-builder/api-server` (app factory, SSE, request context), `@pipeline-builder/pipeline-data` (Drizzle + `CrudService`), and `@pipeline-builder/pipeline-core` (config, synth-side helpers).

## Endpoints

The service listens on port `3000`. The API gateway (nginx) routes `/api/pipelines*` and `/api/pipeline-templates*` here, rewriting to the internal `/pipelines/*` and `/pipeline-templates/*` paths below. Every route needs an authenticated caller with an org; write routes need `pipelines:write` and follow the visibility ladder (`pipelines:publish` for a public pipeline, authorship for a private one).

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/pipelines` | List pipelines (paginated, filtered) |
| GET | `/pipelines/find` | Find a single pipeline by query filter |
| GET | `/pipelines/deleted` | List the org's soft-deleted pipelines |
| GET | `/pipelines/:id` | Get pipeline by ID (`?resolve=true` expands templates) plus its deploy registration |
| POST | `/pipelines` | Create a pipeline (consumes `pipelines` quota; `?upsert=true` overwrites a taken slot) |
| POST | `/pipelines/validate` | Run every create-time check without writing |
| PUT | `/pipelines/:id` | Update a pipeline (`isDefault: true` promotes it) |
| DELETE | `/pipelines/:id` | Soft-delete a pipeline |
| POST | `/pipelines/:id/restore` | Restore a soft-deleted pipeline (step-up) |
| POST | `/pipelines/:id/purge` | Hard-delete a tombstone (step-up; `?force=true` when still registered) |
| POST | `/pipelines/bulk/create` | Bulk create (`bulk_operations` gate) |
| POST | `/pipelines/bulk/delete` | Bulk delete (`bulk_operations` gate) |
| PUT | `/pipelines/bulk/update` | Bulk update (`bulk_operations` gate) |
| GET | `/pipelines/registry` | List deployed-pipeline registry entries |
| POST | `/pipelines/registry` | Upsert a registry entry + step manifest (`pipeline_registry:write`) |
| DELETE | `/pipelines/registry/:id` | Remove a registry entry (`pipeline_registry:write`) |
| POST | `/pipelines/:pipelineId/executions` | Start a CodePipeline execution of a registered pipeline |
| POST | `/pipelines/:pipelineId/executions/:executionId/stop` | Stop an in-flight execution |
| POST | `/pipelines/:id/plugin-upgrades/preview` | Steps needing a plugin upgrade (`pipelines:read`; writes nothing) |
| POST | `/pipelines/plugin-upgrades/apply` | Apply plugin upgrades across up to 50 pipelines (optional redeploy) |
| POST | `/pipelines/:id/security-reports` | Upload a scan report (`reporting:ingest`-scoped key or `pipelines:write`) |
| GET | `/pipelines/:id/security-reports` | Latest report per (tool, stage) |
| DELETE | `/pipelines/:id/security-reports` | Remove one (tool, stage) report slot |
| GET | `/pipelines/:id/scorecard` | Per-pipeline maturity scorecard (`advanced_reporting` gate) |
| GET | `/pipelines/scorecard` | Org-wide scorecard roll-up (`advanced_reporting` gate) |
| GET | `/pipelines/providers` | List available AI generation providers |
| POST | `/pipelines/generate` | Generate a pipeline from a prompt (`ai_generation` gate) |
| POST | `/pipelines/generate/stream` | Generate a pipeline (SSE stream) |
| POST | `/pipelines/generate/from-url` | Analyze a Git repo URL and generate (JSON; drafts only) |
| POST | `/pipelines/generate/from-url/stream` | Analyze a Git repo URL and stream generation (proposes missing plugins) |
| POST | `/pipelines/analyze/from-url` | Repository analysis only, no AI call |
| POST | `/pipelines/generate/missing-plugins` | Create the placeholder plugins the user confirmed (`plugins:write`) |
| GET | `/pipeline-templates` | List templates (`templates:read`) |
| GET | `/pipeline-templates/deleted` | List the org's soft-deleted templates |
| GET | `/pipeline-templates/:id` | Get a template |
| POST | `/pipeline-templates/:id/instantiate` | Render a template into pipeline `props` |
| POST | `/pipeline-templates` | Author a template (`templates:write`) |
| PUT | `/pipeline-templates/:id` | Update a template |
| DELETE | `/pipeline-templates/:id` | Soft-delete a template |
| POST | `/pipeline-templates/:id/restore` | Restore a template (step-up) |
| POST | `/pipeline-templates/:id/purge` | Hard-delete a template tombstone (step-up) |

## Configuration

Shared server/auth/DB settings (`PORT`, `DB_*`, `PLATFORM_BASE_URL`, CORS, Redis) are read via `@pipeline-builder/pipeline-core` / `@pipeline-builder/api-core`, and AI provider keys via `@pipeline-builder/ai-core`. Env vars read directly by this service:

| Variable | Purpose | Default |
|----------|---------|---------|
| `PIPELINE_PLUGIN_SERVICE_TIMEOUT_MS` | Timeout for calls into the plugin service (placeholder-plugin creation) (ms) | `30000` |
| `PIPELINE_GENERATE_RATE_LIMIT_PER_MIN` | Per-org burst cap on the AI generation routes, and separately on `/analyze/from-url` | `20` |
| `PIPELINE_EXEC_IDEMPOTENCY_WINDOW_SECONDS` | Window in which a repeated execution trigger for the same pipeline is refused (409) | `10` |
| `ORG_SCORECARD_MAX_PIPELINES` | Max pipelines graded per org scorecard roll-up page | `50` |
| `ORG_SCORECARD_CONCURRENCY` | Concurrent per-pipeline computes in a roll-up | `4` |
| `AWS_REGION` | CodePipeline region when a registry row names none | — |

## Development

```bash
pnpm build   # projen build (compile + test + package)
pnpm compile # tsc only
pnpm test    # jest
pnpm watch   # incremental compile
```

The service never changes the database schema at runtime: it connects as a non-superuser application role, and the schema comes from `postgres-init.sql`. CRUD and access control are centralized in `PipelineService`, which extends the shared `CrudService` for consistent multi-tenant queries and pagination.

## License

Apache-2.0
