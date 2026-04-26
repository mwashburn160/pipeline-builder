# Local Deployment (Docker Compose)

Local development deployment using Docker Compose with all services, PostgreSQL, MongoDB, and Nginx reverse proxy.

## Quick Start

```bash
# 1. Copy and configure environment
cp .env.example .env

# 2. Start all services
docker compose up -d

# 3. Initialize platform (register admin, load plugins/pipelines)
../bin/init-platform.sh local
```

## AI Providers

To use AI-powered generation, set API keys in `.env`:

```bash
ANTHROPIC_API_KEY=your-key
OPENAI_API_KEY=your-key
GOOGLE_GENERATIVE_AI_API_KEY=your-key
XAI_API_KEY=your-key
```

## Services

| Service | Port | Description |
|---------|------|-------------|
| nginx | 8443 (HTTPS), 8080 (HTTP) | Reverse proxy (exposed) |
| frontend | 3000 (internal) | Next.js dashboard (via nginx) |
| platform | 3000 (internal) | Auth + user management |
| pipeline | 3000 (internal) | Pipeline CRUD + AI generation |
| plugin | 3000 (internal) | Plugin CRUD + builds |
| plugin-dind | 2376 (internal) | Docker-in-Docker sidecar for isolated plugin builds |
| quota | 3000 (internal) | Quota enforcement |
| billing | 3000 (internal) | Subscription management |
| message | 3000 (internal) | Message routing + WebSocket |
| compliance | 3000 (internal) | Per-org compliance rule enforcement |
| reporting | 3000 (internal) | Execution analytics |
| postgres | 5432 (internal) | PostgreSQL database |
| mongodb | 27017 (internal) | MongoDB (platform, quota, billing) |
| redis | 6379 (internal) | Job queue (BullMQ) for plugin builds + compliance events |
| pgadmin | 5480 (exposed) | PostgreSQL admin UI |
| mongo-express | 8081 (exposed) | MongoDB admin UI |
| registry | 5000 (exposed) | Docker image registry |
| registry-express | 5080 (exposed) | Registry web UI |
| grafana | 3200 (exposed) | Monitoring dashboards |

## Troubleshooting

**`docker compose up` fails with `unauthorized: authentication required` on `ghcr.io/mwashburn160/...`:**
Authenticate with the GitHub Container Registry first:

```bash
echo $YOUR_PAT | docker login ghcr.io -u USERNAME --password-stdin
```

`YOUR_PAT` is a GitHub Personal Access Token with the `read:packages` scope. The login is cached in `~/.docker/config.json` and persists across `docker compose` runs.

