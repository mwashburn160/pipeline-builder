# Pipeline Service

Pipeline management API service. Provides CRUD operations for CI/CD pipeline configurations, bulk operations, a deployed-pipeline registry for event reporting and drift detection, and AI-powered pipeline generation from natural language or Git repositories.

## Endpoints

### Pipeline CRUD

| Method | Path | Description |
|--------|------|-------------|
| GET | `/pipelines` | List pipelines (paginated, filtered) |
| GET | `/pipelines/find` | Get a single pipeline matching a filter |
| GET | `/pipelines/:id` | Get pipeline by ID (`?resolve=true` expands `{{ ... }}` templates) |
| POST | `/pipelines` | Create a new pipeline |
| PUT | `/pipelines/:id` | Update a pipeline |
| DELETE | `/pipelines/:id` | Soft-delete a pipeline (admin-only) |

### Bulk Operations

| Method | Path | Description |
|--------|------|-------------|
| POST | `/pipelines/bulk/create` | Create multiple pipelines in one request |
| POST | `/pipelines/bulk/delete` | Soft-delete multiple pipelines by ID |
| PUT | `/pipelines/bulk/update` | Update multiple pipelines with shared data |

Bulk routes are gated by the `bulk_operations` feature flag. Non-private pipelines require system admin to bulk delete/update.

### Registry

The registry maps deployed pipeline ARNs to their owning org for event reporting and drift detection (the `pipeline-manager audit-stacks` CLI joins it against live CloudFormation stacks). Account IDs and ARNs are hashed before storage.

| Method | Path | Description |
|--------|------|-------------|
| GET | `/pipelines/registry` | List registry entries owned by the caller's org (paginated) |
| POST | `/pipelines/registry` | Upsert a pipeline ARN mapping |
| DELETE | `/pipelines/registry/:id` | Remove a single registry entry (hard delete, org-scoped) |

### AI Generation

AI generation endpoints are gated by the `ai_generation` feature flag and consume the org's `aiCalls` quota (reserved atomically before the LLM call and rolled back on failure or stream abort).

| Method | Path | Description |
|--------|------|-------------|
| GET | `/pipelines/providers` | List available AI providers |
| POST | `/pipelines/generate` | Generate pipeline config from prompt |
| POST | `/pipelines/generate/stream` | Stream pipeline generation as SSE |
| POST | `/pipelines/generate/from-url/stream` | Analyze Git URL + stream pipeline generation |

### Git URL Generation Flow

`POST /pipelines/generate/from-url/stream` accepts a Git repository URL and streams SSE events:

1. `analyzing` — fetching repository metadata from GitHub/GitLab/Bitbucket API
2. `analyzed` — repository summary (languages, frameworks, project type, package manager, Dockerfile/CDK detection)
3. `partial` — streaming AI-generated pipeline config chunks
4. `done` — final complete pipeline configuration
5. `checking-plugins` — verifying referenced plugins exist
6. `creating-plugins` — auto-creating missing plugins via the plugin service (with build request IDs)

An `error` event is emitted if repository analysis fails, and the stream terminates with a `[DONE]` sentinel. Missing-plugin auto-creation is capped at 5 concurrent requests and uses an idempotency key per (request, plugin) so retries don't enqueue duplicate builds.

Supports GitHub, GitLab, Bitbucket, and self-hosted Git URLs (HTTPS, SSH, git@ formats).

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `SSE_STREAM_TIMEOUT_MS` | `300000` | SSE stream timeout (ms) |
| `GITHUB_API_BASE_URL` | `https://api.github.com` | GitHub API base URL (for Enterprise) |
| `BITBUCKET_API_BASE_URL` | `https://api.bitbucket.org/2.0` | Bitbucket API base URL |
| `PLUGIN_SERVICE_HOST` | `plugin` | Plugin service hostname |
| `PLUGIN_SERVICE_PORT` | `3000` | Plugin service port |
| `PIPELINE_PLUGIN_SERVICE_TIMEOUT_MS` | `30000` | Timeout for calls into the plugin service (ms) |

AI provider keys are read from the environment (e.g. `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`); `GET /pipelines/providers` returns the providers with a key configured.

## Services

- **PipelineService** — CRUD + bulk operations via the `CrudService` base class
- **PipelineRegistryService** — ARN-to-org mapping for deployed pipelines (event reporting, drift detection)
- **AI Generation Service** — Vercel AI SDK integration for pipeline config generation, with provider fallback
- **Git Analysis Service** — Multi-provider repository analysis (GitHub, GitLab, Bitbucket)
- **Plugin Lookup Service** — batched existence checks against the plugin service for auto-creation
