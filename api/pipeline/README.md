# Pipeline Service

Pipeline management API service. Provides CRUD operations for CI/CD pipeline configurations and AI-powered pipeline generation from Git repositories.

## Endpoints

### Pipeline CRUD

| Method | Path | Description |
|--------|------|-------------|
| GET | `/pipelines` | List pipelines (paginated, filtered) |
| GET | `/pipelines/:id` | Get pipeline by ID |
| POST | `/pipelines` | Create a new pipeline |
| PUT | `/pipelines/:id` | Update a pipeline |
| DELETE | `/pipelines/:id` | Soft-delete a pipeline |

### AI Generation

| Method | Path | Description |
|--------|------|-------------|
| GET | `/pipelines/providers` | List available AI providers |
| POST | `/pipelines/generate` | Generate pipeline config from prompt |
| POST | `/pipelines/generate/stream` | Stream pipeline generation as SSE |
| POST | `/pipelines/generate/from-url/stream` | Analyze Git URL + stream pipeline generation |

### Git URL Generation Flow

`POST /pipelines/generate/from-url/stream` accepts a Git repository URL and streams SSE events:

1. `analyzing` — fetching repository metadata from GitHub/GitLab/Bitbucket API
2. `analyzed` — repository summary (languages, frameworks, project type)
3. `partial` — streaming AI-generated pipeline config chunks
4. `done` — final complete pipeline configuration
5. `checking-plugins` — verifying referenced plugins exist
6. `creating-plugins` — auto-creating missing plugins (with build request IDs)

Supports GitHub, GitLab, Bitbucket, and self-hosted Git URLs (HTTPS, SSH, git@ formats).

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `SSE_STREAM_TIMEOUT_MS` | `300000` | SSE stream timeout (ms) |
| `GITHUB_API_BASE_URL` | `https://api.github.com` | GitHub API base URL (for Enterprise) |
| `BITBUCKET_API_BASE_URL` | `https://api.bitbucket.org/2.0` | Bitbucket API base URL |
| `PLUGIN_SERVICE_HOST` | `plugin` | Plugin service hostname |
| `PLUGIN_SERVICE_PORT` | `3000` | Plugin service port |

## Services

- **PipelineService** — CRUD operations via CrudService base class
- **AI Generation Service** — Vercel AI SDK integration for pipeline config generation
- **Git Analysis Service** — Multi-provider repository analysis (GitHub, GitLab, Bitbucket)
