# Local Deployment (Docker Compose)

Local development deployment using Docker Compose with all services, PostgreSQL, MongoDB, Nginx reverse proxy, and Ollama for local AI generation.

## Quick Start

```bash
# 1. Copy and configure environment
cp .env.example .env

# 2. Start all services
docker compose up -d

# 3. Initialize platform (register admin, load plugins/pipelines)
../bin/init-platform.sh local
```

## Ollama (Local AI)

Ollama runs as a Docker Compose service and provides local LLM inference with no API key required. The default model (`llama3`) is pulled automatically on first boot via the `ollama-pull` init container.

### Pulling Additional Models

```bash
docker exec ollama ollama pull codellama
```

### Available Models

| Model | Command | Size |
|-------|---------|------|
| Llama 3 | `docker exec ollama ollama pull llama3` | ~4.7 GB |
| Llama 3 70B | `docker exec ollama ollama pull llama3:70b` | ~40 GB |
| Code Llama | `docker exec ollama ollama pull codellama` | ~3.8 GB |
| Mistral | `docker exec ollama ollama pull mistral` | ~4.1 GB |
| DeepSeek Coder V2 | `docker exec ollama ollama pull deepseek-coder-v2` | ~8.9 GB |
| Qwen 2.5 Coder | `docker exec ollama ollama pull qwen2.5-coder` | ~4.7 GB |

### Configuration

In `.env`:

```bash
# Default — points to the Docker Compose Ollama service
OLLAMA_BASE_URL=http://ollama:11434/v1

# Or use a host-installed Ollama (outside Docker)
# OLLAMA_BASE_URL=http://host.docker.internal:11434/v1
```

### Verify Ollama is Running

```bash
# Check container health
docker exec ollama ollama list

# Test API endpoint
curl http://localhost:11434/api/tags
```

## Cloud AI Providers (Optional)

To use cloud providers instead of (or in addition to) Ollama, uncomment and set API keys in `.env`:

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
| ollama | 11434 (exposed) | Local LLM inference |
| pgadmin | 5480 (exposed) | PostgreSQL admin UI |
| mongo-express | 8081 (exposed) | MongoDB admin UI |
| registry | 5000 (exposed) | Docker image registry |
| registry-express | 5080 (exposed) | Registry web UI |
| grafana | 3200 (exposed) | Monitoring dashboards |

## Resource Requirements

Ollama requires significant resources for model inference:

- **Minimum**: 8 GB RAM, 4 CPU cores (for smaller models like llama3)
- **Recommended**: 16 GB RAM, 8 CPU cores (for 70B models)
- **GPU**: Optional but significantly improves inference speed

The Docker Compose config limits Ollama to 4 CPUs / 8 GB memory by default. Adjust in `docker-compose.yml` under `ollama.deploy.resources`.
