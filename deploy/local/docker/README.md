# Local Deployment (Docker Compose)

Local development deployment using Docker Compose with all services, PostgreSQL, MongoDB, and Nginx reverse proxy.

## Quick Start

```bash
# 1. Copy and configure environment
cp .env.example .env

# 2. Start all services
docker compose up -d

# 3. Initialize platform (register admin, load plugins/pipelines)
../../bin/init-platform.sh local
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
| registry | 5000 (exposed) | Docker image registry |
| prometheus | 9090 (internal) | Metrics scrape target for the native Observability dashboards |
| loki | 3100 (internal) | Log store for the native Audit Activity dashboard |

Registry browser: open `https://localhost:8443/dashboard/registry` (system-admin only) — the native UI replaces the joxit `registry-express` container that previously listened on port 5080.

Observability: open `https://localhost:8443/dashboard/observability` (system-admin only) — native dashboards (Plugin Builds, Audit Activity) over Prometheus + Loki. Replaces the previously-embedded Grafana iframe, which has been removed.

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

