# Image Registry Service

Authentication and management layer in front of a Docker Distribution registry. It mints short-lived, scoped registry tokens for the [Distribution token-auth flow](https://distribution.github.io/distribution/spec/auth/token/), enforces multi-tenant namespace isolation on every push and pull, and exposes a sysadmin-only management API (list, inspect, copy, prune) that proxies the underlying registry with the service's own credentials. Customers — and the platform's CodeBuild jobs and Lambdas — only ever talk to this service; they never reach the underlying registry directly.

## What it does

- **Token issuance** — implements the Docker Distribution `/token` endpoint. Clients authenticate via Basic auth (a platform-issued JWT supplied as the password, or interactive `docker login` credentials), and receive an RS256-signed JWT scoped to exactly the repositories and actions they are allowed to use.
- **Namespace policy** — any authenticated identity may pull from `system/*` and `library/*`; an org may pull and push within its own `org-{orgId}/*` namespace; system admins may push anywhere. This is enforced when scopes are authorized, so an unauthorized push never even gets a usable token.
- **Storage-quota push gate** — before granting `push` on an org namespace, the service checks the org's `storageBytes` quota and strips `push` when the org is over budget (`pull` is preserved so existing images stay reachable). Fail-open on quota-service errors.
- **Management API** — sysadmin-only routes to list repositories, list tags, fetch and delete manifests, preview small config blobs, and copy/promote tags across repositories.
- **Storage rollup & garbage collection** — per-namespace byte rollups (cached) plus application-level GC that prunes manifests older than a retention window, available both on a schedule and on demand.

## Authentication

This service uses two distinct auth mechanisms:

- **`/token`** — Basic auth, validated inside the route (it never passes through the Bearer-JWT middleware, because the password *is* the credential). `resolveIdentity` tries two paths in order:
  1. **Password as platform JWT** — verified against the platform's `JWT_SECRET`. This is the path used by customer CodeBuild, the plugin-lookup Lambda, and `api/plugin` minting service tokens for its own pushes.
  2. **`docker login`** — the supplied credentials are forwarded to the platform's `/auth/login`, and the returned JWT is verified through path 1. Disabled unless `PLATFORM_BASE_URL` is set, to avoid surprise outbound calls.
- **`/api/images` and `/api/admin`** — standard Bearer JWT (`requireAuth`), then system-admin gated per route.

Identities never reach the underlying registry. The management API proxies it with the service-account credentials in `IMAGE_REGISTRY_USERNAME` / `IMAGE_REGISTRY_PASSWORD`.

## Endpoints

### Token

| Method | Path | Description |
|--------|------|-------------|
| GET | `/token` | Docker Distribution token endpoint. Basic auth; returns an RS256 JWT scoped to the requested `?scope=` (repeatable). Empty scope is valid — `docker login` probes it to verify credentials. Per-identity rate limited (default 60 req / 60s). |

### Images (system admin only)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/images` | List repositories. Cursor-paginated over the registry `_catalog`; pass the response `next` back as `?last=`. |
| GET | `/api/images/:name/tags` | List tags for one repository. |
| GET | `/api/images/:name/manifests/:reference` | Fetch a manifest (single-arch or multi-arch index) plus its resolved digest. |
| DELETE | `/api/images/:name/manifests/:reference` | Resolve the reference to a digest, then delete the manifest. Emits a `registry.tag.delete` audit event. |
| GET | `/api/images/:name/blobs/:digest` | Stream a config blob for the manifest-summary UI. Capped at 5 MB — layer blobs and attestations are rejected with `413`. |
| POST | `/api/images/copy` | Cross-repo, multi-arch-aware tag copy / promotion. |

### Admin (system admin only)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/admin/storage/:prefix` | Per-namespace storage rollup (unique blob bytes). Cached for 60s; `?force=true` recomputes. |
| POST | `/api/admin/gc` | Prune old manifests under a repo namespace. Body: `{ prefix, maxAgeDays?, dryRun? }`. |

### Health

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Liveness/readiness. No Postgres dependency — this service does not use a database. |

## Tag copy & promotion

`POST /api/images/copy` copies a manifest from `source` to `target` (each a `<repo>:<ref>` string). Because repo names may contain `/`, the parser splits on the **last** colon.

- **Multi-arch aware** — for an image index, every referenced child manifest is copied and every unique blob digest across all children is cross-mounted exactly once, then the index is PUT at the target. Cross-mounting avoids transferring layer bytes within the same registry.
- **Idempotent** — re-running with the same arguments is a no-op.
- **Overwrite guard** — without `overwrite: true`, a target tag that already exists with a *different* digest returns `409 target-exists`.
- **Cross-tenant guard** — copying between two distinct `org-*` namespaces requires an explicit `allowCrossTenant: true`. Promotions into `system/*` and copies within one org need no flag.
- **OCI validation** — manifests missing `config.digest` are rejected (`400 invalid-manifest`); a referenced blob or child that goes missing mid-copy yields `409 source-incomplete`.

Promotions into `system/*` emit a `registry.tag.copy` audit event flagged `isPromotionToSystem` and increment a dedicated promotion counter.

## Garbage collection

Application-level GC walks every repo under a namespace prefix, reads each manifest's `created` timestamp (top-level field, OCI annotation, or the config blob), and deletes manifests older than `maxAgeDays` (default 30). `dryRun` logs candidates without deleting.

> GC deletes the **manifest reference**. Reclaiming bytes on disk is a separate operator step — the underlying `registry garbage-collect` command, scheduled off-peak — which this service does not drive.

GC runs two ways:

- **Scheduled** — an in-process sweep over all `org-*` namespaces. Opt-in via `REGISTRY_GC_ENABLED=true` (default off); first run after a startup delay, then every `REGISTRY_GC_INTERVAL_HOURS`. Stops cleanly on `SIGTERM`. A deployed `registry-gc` CronJob can also drive the same prune by calling `POST /api/admin/gc` against each namespace.
- **Manual** — `POST /api/admin/gc` for one-off runs against a single namespace.

After a prune, the storage rollup cache for the affected namespace is invalidated so the dashboard reflects freed space promptly.

## Configuration

Secrets accept either the bare env var or a `_FILE`-suffixed path (Docker/K8s secrets); set one, not both.

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | HTTP listen port | `3000` |
| `IMAGE_REGISTRY_HOST` | Underlying registry host (**required**) | — |
| `IMAGE_REGISTRY_PORT` | Underlying registry port | `5000` |
| `IMAGE_REGISTRY_HTTP` | Use `http://` instead of `https://` | `false` |
| `IMAGE_REGISTRY_INSECURE` | Skip TLS verification (self-signed registries) | `false` |
| `IMAGE_REGISTRY_USERNAME` / `_PASSWORD` | Service-account credentials for management ops | — |
| `REGISTRY_TOKEN_PRIVATE_KEY` | RS256 private key used to sign issued tokens | — |
| `REGISTRY_TOKEN_CERTIFICATE` | x509 cert the registry trusts; used to compute the libtrust `kid` | — |
| `REGISTRY_TOKEN_ISSUER` | `iss` claim; must match the registry's `REGISTRY_AUTH_TOKEN_ISSUER` | `platform` |
| `REGISTRY_TOKEN_SERVICE` | `aud`/`service`; must match the registry's `REGISTRY_AUTH_TOKEN_SERVICE` | `pipeline-image-registry` |
| `REGISTRY_TOKEN_EXPIRES_IN` | Token lifetime, seconds | `300` |
| `JWT_SECRET` | Platform JWT verification secret (for the `/token` Basic-auth path) | — |
| `JWT_ISSUER` / `JWT_AUDIENCE` | Optional platform-JWT `iss` / `aud` constraints | — |
| `PLATFORM_BASE_URL` | Platform service URL; enables the `docker login` path | _(empty — disabled)_ |
| `REGISTRY_GC_ENABLED` | Enable the in-process GC scheduler | `false` |
| `REGISTRY_GC_INTERVAL_HOURS` / `_MAX_AGE_DAYS` / `_STARTUP_DELAY_MS` | GC cadence, retention, startup delay | `24` / `30` / `300000` |

The token signing key pairs with the cert the registry verifies against (its `REGISTRY_AUTH_TOKEN_ROOTCERTBUNDLE`); the libtrust `kid` is computed from that cert at startup so the registry can match the signing key.

## Development

```bash
pnpm dlx projen build    # compile + lint + test
pnpm dlx projen test     # tests only
pnpm start               # run the compiled service (node lib/index.js)
```

The full HTTP contract — request/response schemas, error `details` shapes, and status codes — is documented in [`openapi.yaml`](./openapi.yaml).
