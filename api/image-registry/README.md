# image-registry

Authentication and management layer in front of a Docker Distribution registry — mints short-lived scoped registry tokens, enforces multi-tenant namespace isolation, and exposes a sysadmin-only management API that proxies the underlying registry.

## Responsibilities

- **Token issuance** — implements the Docker Distribution `/token` endpoint. Clients authenticate via Basic auth (a platform-issued JWT as the password, or `docker login` creds forwarded to the platform's `/auth/login`) and receive an RS256-signed JWT scoped to exactly the repositories and actions they may use.
- **Namespace policy** — any authenticated identity may pull `system/*` and `library/*`; an org may pull/push its own `org-{orgId}/*` namespace; system admins may push anywhere. Enforced when scopes are authorized, so an unauthorized push never gets a usable token.
- **Storage-quota push gate** — strips `push` scope on an org namespace when the org is over its `storageBytes` quota (fail-open on quota errors); `pull` is preserved.
- **Management API** — sysadmin-only routes to list repositories, list tags, fetch/delete manifests, preview small config blobs, and copy/promote tags.
- **Storage rollup & GC** — per-namespace byte rollups (cached) plus application-level garbage collection that prunes manifests older than a retention window, on a schedule or on demand.

Built on the shared core packages: `@pipeline-builder/api-core` (auth middleware, logging) and `@pipeline-builder/api-server` (app factory, request context). Does **not** use Postgres — it proxies the underlying registry's v2 API over HTTP.

## Endpoints

The service listens on port `3000` (env `PORT`). The API gateway (nginx) routes `/image-registry/*` and the Distribution `/token` realm here.

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/token` | Docker Distribution token-auth issuer (Basic auth; returns a scoped RS256 JWT) |
| GET | `/api/images` | List repositories (sysadmin) |
| GET | `/api/images/:name/tags` | List tags for a repository (sysadmin) |
| GET | `/api/images/:name/manifests/:reference` | Fetch a manifest (sysadmin) |
| DELETE | `/api/images/:name/manifests/:reference` | Delete a manifest/tag (sysadmin) |
| GET | `/api/images/:name/blobs/:digest` | Proxy a (small) config blob (sysadmin) |
| POST | `/api/images/copy` | Copy/promote a tag across repositories (sysadmin) |
| GET | `/api/admin/storage/:prefix` | Per-namespace storage rollup (sysadmin) |
| POST | `/api/admin/gc` | Trigger garbage collection on demand (sysadmin) |

## Configuration

This service loads its own config (`src/config`) rather than the shared server config. Secrets accept either the bare variable or a `*_FILE` path (Docker/K8s secrets).

| Variable | Purpose | Default |
|----------|---------|---------|
| `PORT` | HTTP listen port | `3000` |
| `IMAGE_REGISTRY_HOST` | Underlying registry host (**required**) | — |
| `IMAGE_REGISTRY_PORT` | Underlying registry port | `5000` |
| `IMAGE_REGISTRY_HTTP` | Use `http://` instead of `https://` | `false` |
| `IMAGE_REGISTRY_INSECURE` | Skip TLS verification (self-signed) | `false` |
| `IMAGE_REGISTRY_USERNAME` | Service creds for the registry's management API (**required**) | — |
| `IMAGE_REGISTRY_PASSWORD` | Service creds for the registry's management API (**required**) | — |
| `REGISTRY_TOKEN_PRIVATE_KEY` | RS256 signing key for issued tokens (**required**) | — |
| `REGISTRY_TOKEN_CERTIFICATE` | Cert the registry trusts; used to compute the JWT `kid` (**required**) | — |
| `REGISTRY_TOKEN_ISSUER` | `iss` claim on issued tokens | `platform` |
| `REGISTRY_TOKEN_SERVICE` | `aud`/`service` value | `pipeline-image-registry` |
| `REGISTRY_TOKEN_EXPIRES_IN` | Token lifetime (s) | `300` |
| `JWT_SECRET` | Platform JWT verification secret (Basic-auth password path) (**required**) | — |
| `JWT_ISSUER` | Expected `iss` on platform JWTs | unset |
| `JWT_AUDIENCE` | Permitted `aud` on platform JWTs | unset |
| `PLATFORM_BASE_URL` | Platform URL for the `docker login` flow; empty disables it | `''` |
| `REGISTRY_TOKEN_RATE_LIMIT_WINDOW_MS` | `/token` rate-limit window (ms) | `60000` |
| `REGISTRY_TOKEN_RATE_LIMIT_MAX` | `/token` requests per window | `60` |
| `REGISTRY_MAX_BLOB_PROXY_BYTES` | Max size of a proxied config blob (bytes) | `5242880` |
| `REGISTRY_COPY_PARALLEL_CHILDREN` | Parallel child manifests during copy | `3` |
| `REGISTRY_COPY_PARALLEL_BLOBS` | Parallel blob copies | `8` |
| `REGISTRY_BLOB_STREAM_TIMEOUT_MS` | Blob stream timeout (ms) | `30000` |
| `REGISTRY_STORAGE_CACHE_TTL_MS` | Storage-rollup cache TTL (ms) | `60000` |
| `REGISTRY_GC_ENABLED` | Enable the in-process GC scheduler | `false` |
| `REGISTRY_GC_INTERVAL_HOURS` | GC run interval (h) | `24` |
| `REGISTRY_GC_MAX_AGE_DAYS` | Prune manifests older than this (days) | `30` |
| `REGISTRY_GC_STARTUP_DELAY_MS` | Delay before the first GC run (ms) | `300000` |

## Development

```bash
pnpm build   # projen build (compile + test + package)
pnpm compile # tsc only
pnpm test    # jest
pnpm watch   # incremental compile
```

The default Postgres health check is disabled (`testDatabase: false`) since the service has no database; on startup it logs the registry target and starts the GC scheduler (opt-in via `REGISTRY_GC_ENABLED`).

## License

Apache-2.0
