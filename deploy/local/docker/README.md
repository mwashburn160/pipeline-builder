# Local Deployment (Docker Compose)

Local development deployment using Docker Compose with all services, PostgreSQL, MongoDB, and Nginx reverse proxy.

## Quick Start

```bash
# 1. Copy and configure environment
cp .env.example .env

# 2. Start all services
docker compose up -d

# 3. Initialize platform (register admin, load plugins/pipelines)
../../bin/init-platform.sh docker
```

## AI Providers

To use AI-powered generation, set API keys in `.env`:

```bash
ANTHROPIC_API_KEY=your-key
OPENAI_API_KEY=your-key
GOOGLE_GENERATIVE_AI_API_KEY=your-key
XAI_API_KEY=your-key
```

### Self-hosted model (no cloud key)

The Ask assistant needs *some* provider — with no key above and no base URL, every
turn fails with *"AI is not configured"*. An opt-in Ollama container can be that
provider:

```bash
docker compose --profile ask-model up -d
```

Then uncomment both lines in `.env` and restart `ask` so it picks them up:

```bash
OPENAI_COMPATIBLE_BASE_URL=http://ask-model:11434/v1
OPENAI_COMPATIBLE_MODELS=qwen2.5-coder:7b|Qwen 2.5 Coder

docker compose up -d ask
```

The first start downloads ~4.7GB, and the container stays **unhealthy** until the
model is actually present — that is deliberate, so `ask` is never pointed at a
server whose catalogue is still empty. The 7B needs ~6-8Gi of RAM to serve; on a
smaller machine set `OLLAMA_MODEL=qwen2.5-coder:1.5b` and change
`OPENAI_COMPATIBLE_MODELS` to match. The two must always name the same model.

Watch the pull with `docker compose logs -f ask-model`.

If you drive the stack through `bin/setup.sh`, enable the profile with the
environment variable instead — `--profile` is a top-level flag and `setup.sh`
appends its arguments after `up`, so it cannot be passed through:

```bash
COMPOSE_PROFILES=ask-model ./bin/setup.sh
```

Set it on **every** subsequent run: `setup.sh` calls `up -d --remove-orphans`, and
without the profile active `ask-model` counts as an orphan and is removed. (The
`ask-model-models` volume survives, so re-enabling it does not re-download.)

## Grafana

Dashboards over the Prometheus/Loki/Jaeger already in this stack. Reached
through nginx at **https://localhost:8443/grafana/** — the same subpath pattern
as pgAdmin.

It has its **own login** (`GRAFANA_ADMIN_USER` / `GRAFANA_ADMIN_PASSWORD` in
`.env`, generated on first provision) because nginx applies no auth to that
route, and Grafana queries Prometheus with **no org scoping** — anyone who gets
in sees every tenant's metrics. That is also why it is admin-only and not linked
from any tenant-facing page. Datasources are provisioned from
`config/grafana/provisioning/`, so a rebuilt container comes back wired.

Unlike the kubernetes targets, Prometheus is the **default** datasource here
rather than Thanos: this target runs no Thanos, so there are no long-range
blocks to fan out to.

**No Kiali on this target.** Kiali visualises an Istio mesh, and docker-compose
runs none — it would render an empty graph. It ships on the three kubernetes
targets instead.

## Services

| Service | Port | Description |
|---------|------|-------------|
| nginx | 8443 (HTTPS), 8080 (HTTP) | Reverse proxy (exposed) |
| frontend | 3000 (internal) | Next.js dashboard (via nginx) |
| platform | 3000 (internal) | Auth + user management |
| pipeline | 3000 (internal) | Pipeline CRUD + AI generation |
| plugin | 3000 (internal) | Plugin CRUD + builds |
| buildkitd | unix socket (internal) | Rootless BuildKit sidecar for isolated plugin builds |
| quota | 3000 (internal) | Quota enforcement |
| billing | 3000 (internal) | Subscription management |
| message | 3000 (internal) | Message routing + WebSocket |
| compliance | 3000 (internal) | Per-org compliance rule enforcement |
| reporting | 3000 (internal) | Execution analytics |
| postgres | 5432 (internal) | PostgreSQL database |
| mongodb | 27017 (internal) | MongoDB (platform, quota, billing) |
| redis | 6379 (internal) | Job queue (BullMQ) for plugin builds + compliance events |
| pgadmin | 5480 (exposed) | PostgreSQL admin UI |
| mongo-express | 27081 (exposed) | MongoDB admin UI |
| grafana | via nginx `/grafana/` | Dashboards over prometheus/loki/jaeger (own login) |
| registry | 5000 (exposed) | Docker image registry |
| prometheus | 9090 (internal) | Metrics scrape target for the native Observability dashboards |
| loki | 3100 (internal) | Log store for the native Audit Activity dashboard |

Registry browser: open `https://localhost:8443/dashboard/registry` (system-admin only) — the native UI replaces the joxit `registry-express` container that previously listened on port 5080.

Observability: open `https://localhost:8443/dashboard/observability` (system-admin only) — native dashboards (Plugin Builds, Audit Activity) over Prometheus + Loki. These replaced an embedded Grafana iframe and remain the tenant-facing, org-scoped surface. The standalone Grafana above is a separate, admin-only console — not an embed, and not linked from any tenant page.

## Troubleshooting

The service images on `ghcr.io/mwashburn160/...` are **public**, so `docker compose up` pulls them with no registry login.

**Browser console shows `net::ERR_CERT_AUTHORITY_INVALID` for JS chunks (`turbopack-*.js`, `_buildManifest.js`, …) and the page renders blank/unstyled:**
The UI is served over HTTPS on `:8443`. Clicking "Proceed anyway" only whitelists the top-level page, not the script/module sub-resources, so the app's JS fails to load. Fix it one of these ways (easiest first):

- **Install [mkcert](https://github.com/FiloSottile/mkcert) and regenerate** — `setup.sh` then issues a browser-trusted cert, so there are no warnings at all:
  ```bash
  brew install mkcert            # macOS (or your platform's package manager)
  rm certs/nginx-tls.crt certs/nginx-tls.key   # drop the old untrusted cert
  ./bin/setup.sh               # regenerates via mkcert + installs its local CA
  ```
- **Instant bypass (Chrome/Edge)** — on the "Your connection is not private" page, click anywhere and type `thisisunsafe` (there's no input box). This bypasses the cert for the whole origin, including the JS chunks.
- **Trust the self-signed cert (macOS)** — then **fully quit and reopen** the browser:
  ```bash
  sudo security add-trusted-cert -d -r trustRoot \
    -k /Library/Keychains/System.keychain certs/nginx-tls.crt
  ```

Always reach the UI at `https://localhost:8443` (the cert covers `localhost` and `127.0.0.1`; `:8080` just redirects to `:8443`).

