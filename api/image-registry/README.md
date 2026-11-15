# image-registry

Authentication and management layer in front of a Docker Distribution registry — mints short-lived scoped registry tokens, enforces multi-tenant namespace isolation, and exposes a permission-gated management API that proxies the underlying registry, plus service-to-service routes for plugin-image signing, the public namespace and storage.

## Responsibilities

- **Token issuance** — implements the Docker Distribution `/token` endpoint. Clients authenticate via Basic auth (a platform-issued token as the password — a USER token verified against platform's published ES256 key set, an internal SERVICE token verified against the per-service public key bundle, or an opaque `pb_pat_…` key exchanged at platform — or `docker login` creds forwarded to the platform's `/auth/login`) and receive an RS256-signed JWT scoped to exactly the repositories and actions they may use.
- **Namespace policy** — any authenticated identity may pull `system/*`, `library/*` and `public/*`; an org may pull its own `org-{orgId}/*` namespace and push there with `plugins:write`; a team may pull its parent org's public plugins; `public/*` is append-only (written only through the internal publication routes), `registry-meta/*` is closed, and `quarantine/*` belongs to the submission's build credential and the plugin service; platform superadmins may push to the remaining namespaces. Enforced when scopes are authorized, so an unauthorized push never gets a usable token.
- **Storage-quota push gate** — strips `push` scope on an org namespace when the org is over its `storageBytes` quota (plus the grace band). Fails closed when the quota or usage cannot be verified (`QUOTA_STORAGE_FAIL_OPEN=true` reverts that); `pull` is preserved.
- **Management API** — system-org routes gated by `registry:read` / `registry:write` / `registry:purge` to list repositories, list tags, fetch/delete manifests and repositories, preview small config blobs, and copy/promote tags.
- **Storage rollup & GC** — per-namespace byte rollups (cached) plus application-level garbage collection that prunes manifests older than a retention window, on a schedule or on demand.

Built on the shared core packages: `@pipeline-builder/api-core` (auth middleware, logging) and `@pipeline-builder/api-server` (app factory, request context). Does **not** use Postgres — it proxies the underlying registry's v2 API over HTTP.

## Endpoints

The service listens on port `3000` (env `PORT`). The API gateway (nginx) routes `/image-registry/*` and the Distribution `/token` realm here.

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/token` | Docker Distribution token-auth issuer (Basic auth; returns a scoped RS256 JWT) |
| GET | `/api/images` | List repositories (`registry:read`, system org) |
| GET | `/api/images/:name/tags` | List tags for a repository (`registry:read`, system org) |
| GET | `/api/images/:name/manifests/:reference` | Fetch a manifest (`registry:read`, system org) |
| DELETE | `/api/images/:name/manifests/:reference` | Delete a manifest/tag (`registry:purge`, aal2) |
| DELETE | `/api/images/:name` | Delete a whole repository (`registry:purge`, aal2) |
| GET | `/api/images/:name/blobs/:digest` | Proxy a (small) config blob (`registry:read`, system org) |
| POST | `/api/images/copy` | Copy/promote a tag across repositories (`registry:read` + `registry:write`, system org, aal2) |
| GET | `/api/admin/storage/:prefix` | Per-namespace storage rollup (`registry:read`, system org) |
| POST | `/api/admin/gc` | Trigger garbage collection on demand (`registry:purge`, aal2) |
| * | `/internal/*` | Service-to-service routes (plugin signing, public publications, discard, quarantine, storage usage/breakdown/prune, org-namespace purge); each carries its own caller allow-list — see `src/routes/internal.ts` |

## Configuration

This service loads its own config (`src/config`) rather than the shared server config. Secrets accept either the bare variable or a `*_FILE` path (Docker/K8s secrets).

| Variable | Purpose | Default |
|----------|---------|---------|
| `PORT` | HTTP listen port | `3000` |
| `IMAGE_REGISTRY_HOST` | Underlying registry host (**required**) | — |
| `IMAGE_REGISTRY_PORT` | Underlying registry port | `5000` |
| `IMAGE_REGISTRY_HTTP` | Use `http://` instead of `https://` | `false` |
| `IMAGE_REGISTRY_INSECURE` | Skip TLS verification (self-signed) | `false` |
| `REGISTRY_TOKEN_PRIVATE_KEY` | RS256 signing key for issued tokens (**required**) | — |
| `REGISTRY_TOKEN_CERTIFICATE` | Cert the registry trusts; carried in each token's JWT `x5c` header (**required**) | — |
| `REGISTRY_TOKEN_ISSUER` | `iss` claim on issued tokens | `platform` |
| `REGISTRY_TOKEN_SERVICE` | `aud`/`service` value | `pipeline-image-registry` |
| `REGISTRY_TOKEN_EXPIRES_IN` | Token lifetime (s) | `300` |
| `SERVICE_SIGNING_KEY_FILE` | This service's OWN ES256 key for the INTERNAL service tokens it mints (its `/auth/login` relay call) (**required**) | — |
| `SERVICE_KEY_BUNDLE_FILE` | The public per-service key bundle it verifies peers' tokens with (api/plugin's own image pushes, the deploy's base-image pushes) (**required**) | — |
| `PLATFORM_JWKS_URL` | Override for platform's published ES256 key set, which the Basic-auth-password path verifies USER tokens against. Defaults to the in-cluster `PLATFORM_SERVICE_HOST`/`PORT` — no secret is involved, and this service can no longer mint a platform token | derived |
| `JWT_ISSUER` | Expected `iss` on platform JWTs | unset |
| `JWT_AUDIENCE` | Permitted `aud` on platform JWTs | unset |
| `PLATFORM_SERVICE_HOST` | In-cluster platform host for the `docker login` flow (password forwarded to `/auth/login`) | `platform` |
| `PLATFORM_SERVICE_PORT` | In-cluster platform port | `3000` |
| `REGISTRY_TOKEN_RATE_LIMIT_WINDOW_MS` | `/token` rate-limit window (ms) | `60000` |
| `REGISTRY_TOKEN_RATE_LIMIT_MAX` | `/token` requests per window per (source IP, username) | `60` |
| `REGISTRY_TOKEN_RATE_LIMIT_IP_MAX` | `/token` requests per window per source IP, across all usernames (anti password-spraying) | `300` |
| `REGISTRY_MAX_BLOB_PROXY_BYTES` | Max size of a proxied config blob (bytes) | `5242880` |
| `REGISTRY_COPY_PARALLEL_CHILDREN` | Parallel child manifests during copy | `3` |
| `REGISTRY_COPY_PARALLEL_BLOBS` | Parallel blob copies | `8` |
| `REGISTRY_BLOB_STREAM_TIMEOUT_MS` | Blob stream timeout (ms) | `30000` |
| `REGISTRY_STORAGE_CACHE_TTL_MS` | Storage-rollup cache TTL (ms) | `60000` |
| `REGISTRY_GC_ENABLED` | Enable the in-process GC scheduler | `false` |
| `REGISTRY_GC_INTERVAL_HOURS` | GC run interval (h) | `24` |
| `REGISTRY_GC_MAX_AGE_DAYS` | Prune manifests older than this (days) | `30` |
| `REGISTRY_GC_STARTUP_DELAY_MS` | Delay before the first GC run (ms) | `300000` |
| `REGISTRY_GC_PROTECTED_TAGS` | Comma-separated floating tags GC never prunes | `latest,stable,main,…` |
| `REGISTRY_HTTP_TIMEOUT_MS` | Timeout for management calls to the underlying registry (ms) | `30000` |
| `PLUGIN_SIGNING_MODE` | Plugin-signing key source: `local` (PEM file) or `kms` | `local` |
| `PLUGIN_SIGNING_KEY_FILE` | EC P-256 PKCS PEM the `local` mode signs with | `/etc/pipeline-builder/plugin-signing/plugin-signing.key` |
| `PLUGIN_SIGNING_KMS_KEY_ID` | KMS key ALIAS (`alias/<name>`) the `kms` mode signs with | — |
| `PLUGIN_SIGNING_TIMEOUT_MS` | Upper bound on one cosign invocation (ms) | `120000` |
| `REGISTRY_SIGN_MAX_CONCURRENT` | Signing operations (and signed-SBOM reads) allowed at once per process; the rest queue | `4` |
| `REGISTRY_SBOM_MAX_BYTES` | Largest SBOM a signing request may stream | `268435456` |
| `PUBLIC_VERIFY_CACHE_TTL_MS` | Per-pod cache of verified `public/*` signatures (ms) | `60000` |

## Development

```bash
pnpm build   # projen build (compile + test + package)
pnpm compile # tsc only
pnpm test    # jest
pnpm watch   # incremental compile
```

The default Postgres health check is disabled (`testDatabase: false`) since the service has no database; on startup it logs the registry target and starts the GC scheduler (opt-in via `REGISTRY_GC_ENABLED`) and the always-on 30-day `quarantine/*` sweep.

## License

Apache-2.0
