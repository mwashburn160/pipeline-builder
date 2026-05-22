# Environment Variables

Complete reference for all environment variables used across Pipeline Builder services. Each variable can be set in your `.env` file or passed directly via your deployment configuration (Docker Compose, Kubernetes ConfigMap, ECS task definition).

**Quick setup:** Copy `.env.example` to `.env` and fill in the required secrets.

> **Security:** Generate JWT secrets with `openssl rand -base64 32`. Never commit `.env` files to version control.

**Related docs:** [AWS Deployment](aws-deployment.md) | [API Reference](api-reference.md)

---

## Table of Contents

- [Core](#core) -- Server basics (port, logging, URLs)
- [Authentication](#authentication) -- JWT, OAuth, password policy
- [Databases](#databases) -- PostgreSQL, MongoDB, Redis
- [Docker Registry](#docker-registry) -- Image registry for plugin builds
- [Plugin Builds](#plugin-builds) -- buildkit sidecar, queue config
- [Quotas & Rate Limiting](#quotas--rate-limiting) -- Per-org resource limits
- [Service Discovery](#service-discovery) -- Inter-service hostnames and ports
- [Compliance](#compliance) -- Compliance bypass and scan scheduling
- [Email](#email) -- SMTP and SES configuration
- [Billing](#billing) -- Subscription billing provider
- [AWS CDK / Lambda](#aws-cdk--lambda) -- Lambda runtime, CodeBuild compute
- [Timeouts](#timeouts) -- Request, build, and connection timeouts
- [Caching](#caching) -- Response and entity cache TTLs
- [SSE](#server-sent-events) -- Server-sent events configuration
- [Admin UIs](#admin-uis-infrastructure) -- pgAdmin, Mongo Express credentials
- [Pagination & Limits](#pagination--limits) -- API response limits
- [AI Providers](#ai-providers-optional) -- API keys for AI-powered generation

---

## Core

| Variable | Default | Description |
|----------|---------|-------------|
| `PLATFORM_BASE_URL` | `https://localhost:8443` | API gateway URL |
| `PLATFORM_FRONTEND_URL` | `https://localhost:8443` | Frontend URL (email links, OAuth redirects) |
| `PORT` | `3000` | Service listen port |
| `TRUST_PROXY` | `1` | Trust proxy headers (behind nginx/ALB) |
| `LOG_LEVEL` | `info` | `error`, `warn`, `info`, `debug` |
| `LOG_FORMAT` | `json` | `json` (structured) or `text` (human-readable) |
| `SERVICE_NAME` | `api` | Service name in logs |
| `CORS_CREDENTIALS` | `true` | Allow credentials in CORS requests |
| `CORS_ORIGIN` | — | CORS allowed origins (optional) |

---

## Authentication

| Variable | Default | Description |
|----------|---------|-------------|
| `JWT_SECRET` | — | **Required.** JWT signing secret. Must be **identical across all services** — `signServiceToken()` mints inter-service tokens with this same secret so any service's `requireAuth` can verify them. |
| `REFRESH_TOKEN_SECRET` | — | **Required.** Refresh token secret |
| `JWT_EXPIRES_IN` | `86400` | Token TTL in seconds (24h). Per-tier overrides take precedence. |
| `JWT_EXPIRES_IN_DEVELOPER` | (inherits `JWT_EXPIRES_IN`) | Developer-tier access-token TTL override |
| `JWT_EXPIRES_IN_PRO` | (inherits `JWT_EXPIRES_IN`) | Pro-tier override — commonly shorter for compliance |
| `JWT_EXPIRES_IN_UNLIMITED` | (inherits `JWT_EXPIRES_IN`) | Enterprise-tier override (e.g. `1800` = 30 min) |
| `JWT_ALGORITHM` | `HS256` | `HS256`, `HS384`, `HS512`, `RS256` |
| `JWT_SALT_ROUNDS` | `12` | bcrypt salt rounds |
| `REFRESH_TOKEN_EXPIRES_IN` | `2592000` | Refresh token TTL (30d) |
| `PASSWORD_MIN_LENGTH` | `12` | Minimum password length |
| `COOKIE_SAME_SITE` | `lax` | `lax`, `strict`, or `none` for refresh cookie |
| `COOKIE_SECURE` | `false` (auto-true in prod) | Set `true` to force the `secure` cookie flag; auto-enabled when `NODE_ENV=production` |
| `BOOTSTRAP_SUPERADMIN_EMAILS` | — | Comma-separated user emails auto-promoted to `isSuperAdmin=true` at platform boot. **Required for fresh installs** — the first sysadmin can only be granted through this env or a direct DB update. Idempotent. |

### Multi-tenant secret encryption

AI provider keys and IdP client secrets are encrypted at rest. `SECRET_ENCRYPTION_KEY` is **required at platform boot** — the read paths no longer fall back to clear text. Existing pre-encryption rows are re-encrypted automatically by the startup backfill.

| Variable | Default | Description |
|----------|---------|-------------|
| `SECRET_ENCRYPTION_KEY` | — | **Required.** 32-byte master key (hex or base64). Generate with `head -c 32 /dev/urandom \| base64`. Platform aborts startup when this is unset in production. |
| `SECRET_ENCRYPTION_PER_ORG_KMS` | `false` | When `true`, each org's secrets are wrapped under its own KMS CMK (see `Organization.kmsConfig`). Orgs without an entry fall through to the shared master. Recommended for SOC2 / compliance deploys. |
| `SECRET_ENCRYPTION_KMS_KEY_ID` | — | (Single-master KMS mode) KMS CMK alias / ARN used to wrap the shared master. |
| `SECRET_ENCRYPTION_KMS_CIPHERTEXT` | — | (Single-master KMS mode) Base64 KMS-wrapped 32-byte master. |

### Multi-tenant RLS context

| Variable | Default | Description |
|----------|---------|-------------|
| `RLS_CONTEXT_MODE` | `warn` | Behavior when `withTenantTx` is called outside any tenant scope. `warn` logs a stack-traced warning, `strict` throws, `silent` is no-op (tests / migration only). Recommended production rollout: `warn` for ≥7 days, then flip to `strict` after the logs show zero spurious warnings. |

### Multi-tenant alert webhook relay

| Variable | Default | Description |
|----------|---------|-------------|
| `ALERT_WEBHOOK_INSTANCES` | — | JSON array of `{ id, token, allowedOrgIds? }` entries. **Required** to enable the relay; unset / empty returns 503 at the webhook endpoint. Each Alertmanager sends `X-Alertmanager-Instance: <id>` + `Authorization: Bearer <token>`. `allowedOrgIds` restricts which orgs that instance can relay alerts for. |
| `ALERT_WEBHOOK_INSTANCE_ID` | — | (Alertmanager side) The id of this Alertmanager's entry. |
| `ALERT_WEBHOOK_INSTANCE_TOKEN` | — | (Alertmanager side) The matching token. |

### Google OAuth (Optional)

| Variable | Default | Description |
|----------|---------|-------------|
| `OAUTH_GOOGLE_CLIENT_ID` | — | Client ID (empty = disabled) |
| `OAUTH_GOOGLE_CLIENT_SECRET` | — | Client Secret |
| `OAUTH_CALLBACK_BASE_URL` | `${PLATFORM_FRONTEND_URL}` | OAuth redirect origin |
| `OAUTH_STATE_TTL_MS` | `600000` | OAuth state token TTL (10 min) |
| `OAUTH_CLEANUP_INTERVAL_MS` | `60000` | Stale state cleanup interval |

### GitHub OAuth (Optional)

| Variable | Default | Description |
|----------|---------|-------------|
| `OAUTH_GITHUB_CLIENT_ID` | — | Client ID (empty = disabled) |
| `OAUTH_GITHUB_CLIENT_SECRET` | — | Client Secret |

---

## Databases

### PostgreSQL

| Variable | Default | Description |
|----------|---------|-------------|
| `POSTGRES_USER` | `postgres` | Superuser (container init) |
| `POSTGRES_PASSWORD` | — | Superuser password |
| `POSTGRES_DB` | `pipeline_builder` | Database name (container init) |
| `DB_HOST` | `postgres` | Host for services |
| `DB_PORT` | `5432` | Port |
| `DB_USER` | `postgres` | User for services |
| `DB_PASSWORD` | — | Password for services |
| `DRIZZLE_MAX_POOL_SIZE` | `20` | Connection pool size |
| `DRIZZLE_IDLE_TIMEOUT_MILLIS` | `30000` | Idle connection timeout (ms) |
| `DRIZZLE_CONNECTION_TIMEOUT_MILLIS` | `10000` | Connection timeout (ms) |
| `DB_MAX_RETRIES` | `3` | Connection retry attempts |
| `DB_RETRY_DELAY_MS` | `1000` | Retry delay (ms) |
| `DB_TRANSACTION_TIMEOUT_MS` | `30000` | Transaction timeout (ms) |
| `DB_CLOSE_TIMEOUT_MS` | `5000` | Connection close timeout (ms) |

### MongoDB

| Variable | Default | Description |
|----------|---------|-------------|
| `MONGO_INITDB_ROOT_USERNAME` | `mongo` | Root username |
| `MONGO_INITDB_ROOT_PASSWORD` | — | Root password |
| `MONGO_INITDB_DATABASE` | `platform` | Initial database |
| `MONGODB_URI` | — | Full connection URI with replica set |

### Redis

| Variable | Default | Description |
|----------|---------|-------------|
| `REDIS_HOST` | `redis` | Hostname |
| `REDIS_PORT` | `6379` | Port |

> Redis must use `maxmemory-policy noeviction` for BullMQ. `allkeys-lru` causes silent job data loss.

---

## Docker Registry

| Variable | Default | Description |
|----------|---------|-------------|
| `IMAGE_REGISTRY_HOST` | `registry` | Registry hostname |
| `IMAGE_REGISTRY_PORT` | `5000` | Registry port |
| `IMAGE_REGISTRY_USER` | `admin` | Registry username |
| `IMAGE_REGISTRY_TOKEN` | — | Registry password/token |
| `IMAGE_REGISTRY_HTTP` | `true` | Plugin builds talk to the in-cluster registry over plain HTTP. Set `false` only if the registry is exposed via a TLS-terminating proxy with a publicly trusted cert. |

---

## Plugin Builds

Every deploy target (Fargate, EC2/k8s, minikube, local docker-compose) runs
plugin builds against a **rootless `moby/buildkit` sidecar**. The plugin
service's `buildctl` connects via the Unix socket exposed by the sidecar —
there is no docker daemon, no kaniko binary, no podman, and no strategy switch.

| Variable | Default | Description |
|----------|---------|-------------|
| `BUILDKIT_HOST` | `unix:///run/buildkit/buildkitd.sock` | buildctl `--addr` for the buildkitd sidecar |
| `DOCKER_BUILD_TIMEOUT_MS` | `900000` | Build timeout (15 min) |
| `DOCKER_PUSH_TIMEOUT_MS` | `300000` | Push timeout (5 min) |
| `PLUGIN_UPLOAD_TIMEOUT_MS` | `300000` | Upload HTTP timeout (5 min) — overrides `HANDLER_TIMEOUT_MS` for the upload route |
| `PLUGIN_MAX_UPLOAD_MB` | `4096` | Max plugin ZIP upload size in MB (supports prebuilt image.tar) |

The plugin image is published with a single tag (`plugin:<version>`) — no
target suffixes (`-docker`, `-kaniko`, `-podman` are gone).

### How the build runs

- **Build from source** (`buildType: build_image`): `buildctl build --frontend dockerfile.v0 --local context=<dir> --local dockerfile=<dir> --output type=image,name=<image>,push=true[,registry.insecure=true]`. buildkitd handles the Dockerfile parse, layer cache, registry push, and bearer-token negotiation.
- **Prebuilt tarball** (`buildType: prebuilt`): `crane push <tar> <image>`. buildctl can build but cannot push pre-existing `docker save` tarballs; the plugin image bundles `crane` for this path only.

### Why no dind / kaniko / podman

- **No privileged containers**: `moby/buildkit:rootless` runs as uid 1000, no `SYS_ADMIN`, no `privileged: true`.
- **No CA-trust workarounds**: buildkitd carries the system CA bundle and follows realm-URL bearer challenges with the host's trust store — no per-container cert mounts, no `update-ca-certificates` shell wrappers.
- **One code path everywhere**: the same `docker-build.ts` runs on Fargate, EC2, minikube, and local. Deploy target only changes the sidecar's hosting (ECS task / k8s pod / compose service).

### Build Queue

| Variable | Default | Description |
|----------|---------|-------------|
| `PLUGIN_BUILD_CONCURRENCY` | `1` | Max concurrent builds per container |
| `PLUGIN_BUILD_QUEUE_NAME` | `plugin-build` | BullMQ queue name |
| `PLUGIN_BUILD_MAX_ATTEMPTS` | `2` | Max build attempts before moving to DLQ |
| `PLUGIN_BUILD_BACKOFF_DELAY_MS` | `5000` | Backoff delay between retries (ms) |
| `PLUGIN_BUILD_COMPLETED_RETENTION_SECS` | `3600` | Completed job retention (1 hour) |
| `PLUGIN_BUILD_FAILED_RETENTION_SECS` | `86400` | Failed job retention (24 hours) |
| `PLUGIN_BUILD_WORKER_TIMEOUT_MS` | `10000` | Worker ready timeout (ms) |
| `PLUGIN_DLQ_MAX_ATTEMPTS` | `3` | Max DLQ retry attempts (exponential backoff) |
| `PLUGIN_DLQ_BACKOFF_BASE_MS` | `300000` | DLQ backoff base delay (5 min; scales 5m, 15m, 45m) |
| `PLUGIN_DLQ_MAX_SIZE` | `20` | Max DLQ jobs before oldest are purged |
| `TEMP_DIR_MAX_AGE_MS` | `14400000` | Stale temp dir cleanup threshold (4 hours) |

---

## Quotas & Rate Limiting

| Variable | Default | Description |
|----------|---------|-------------|
| `QUOTA_DEFAULT_PLUGINS` | `100` | Max plugins per org |
| `QUOTA_DEFAULT_PIPELINES` | `10` | Max pipelines per org |
| `QUOTA_DEFAULT_API_CALLS` | `-1` | Max API calls (`-1` = unlimited) |
| `QUOTA_DEFAULT_AI_CALLS` | `100` | Max AI generation invocations per period (sized smaller than `apiCalls` because each call has external $ cost) |
| `QUOTA_RESET_DAYS` | `3` | Reset period (days) |
| `QUOTA_SERVICE_HOST` | `quota` | Quota service host |
| `QUOTA_SERVICE_PORT` | `3000` | Quota service port |
| `LIMITER_MAX` | `100` | Global rate limit (requests/window) |
| `LIMITER_WINDOWMS` | `900000` | Global rate limit window (15 min) |
| `RATE_LIMIT_MAX` | `100` | Per-route rate limit |
| `RATE_LIMIT_WINDOW_MS` | `60000` | Per-route rate limit window (1 min) |
| `AUTH_LIMITER_MAX` | `20` | Auth endpoint rate limit |
| `AUTH_LIMITER_WINDOWMS` | `900000` | Auth rate limit window (15 min) |

Tier presets ship in `@pipeline-builder/api-core` (`QUOTA_TIERS` in `quota-tiers.ts`):

| Tier | plugins | pipelines | apiCalls | aiCalls |
|------|---------|-----------|----------|---------|
| developer | 100 | 10 | unlimited | 100 |
| pro | 1000 | 100 | unlimited | 5000 |
| unlimited | unlimited | unlimited | unlimited | unlimited |

Per-call increments to `/quotas/:orgId/increment` cap `amount` at 1000 — bounds the per-request blast radius from a buggy or malicious caller.

---

## Service Discovery

| Variable | Default | Description |
|----------|---------|-------------|
| `PLUGIN_SERVICE_HOST` | `plugin` | Plugin service hostname |
| `PLUGIN_SERVICE_PORT` | `3000` | Plugin service port |
| `PIPELINE_SERVICE_HOST` | `pipeline` | Pipeline service hostname |
| `PIPELINE_SERVICE_PORT` | `3000` | Pipeline service port |
| `MESSAGE_SERVICE_HOST` | `message` | Message service hostname |
| `MESSAGE_SERVICE_PORT` | `3000` | Message service port |
| `COMPLIANCE_SERVICE_HOST` | `compliance` | Compliance service hostname |
| `COMPLIANCE_SERVICE_PORT` | `3000` | Compliance service port |
| `BILLING_SERVICE_HOST` | `billing` | Billing service hostname |
| `BILLING_SERVICE_PORT` | `3000` | Billing service port |
| `QUOTA_SERVICE_HOST` | `quota` | Quota service hostname |
| `QUOTA_SERVICE_PORT` | `3000` | Quota service port |

---

## Compliance

| Variable | Default | Description |
|----------|---------|-------------|
| `COMPLIANCE_BYPASS` | `false` | Bypass compliance checks when service is unavailable (dev/DR only) |
| `COMPLIANCE_ENABLED` | `true` | Enable compliance enforcement |
| `SCAN_SCHEDULER_INTERVAL_MS` | `60000` | Compliance scan scheduler interval (ms) |

---

## Email

| Variable | Default | Description |
|----------|---------|-------------|
| `EMAIL_ENABLED` | `false` | Enable email sending |
| `EMAIL_FROM` | `noreply@example.com` | Sender address |
| `EMAIL_FROM_NAME` | `pipeline-builder` | Sender display name |
| `EMAIL_PROVIDER` | `smtp` | `smtp` or `ses` |
| `SMTP_HOST` | `localhost` | SMTP host |
| `SMTP_PORT` | `587` | SMTP port |
| `SMTP_SECURE` | `false` | Use TLS |
| `SMTP_USER` | — | SMTP username |
| `SMTP_PASS` | — | SMTP password |

For AWS SES: set `EMAIL_PROVIDER=ses` with `SES_REGION`, `SES_ACCESS_KEY_ID`, `SES_SECRET_ACCESS_KEY`.

---

## Billing

| Variable | Default | Description |
|----------|---------|-------------|
| `BILLING_ENABLED` | `false` | Enable billing |
| `BILLING_PROVIDER` | `stub` | `stub`, `aws-marketplace`, or `stripe` |
| `BILLING_SERVICE_HOST` | `billing` | Service hostname |
| `BILLING_SERVICE_PORT` | `3000` | Service port |
| `BILLING_LIFECYCLE_CHECK_INTERVAL_MS` | `3600000` | Subscription lifecycle check interval (1 hour) |
| `PAYMENT_GRACE_PERIOD_DAYS` | `7` | Grace period for overdue payments |
| `RENEWAL_REMINDER_DAYS` | `7` | Days before expiry to send renewal reminder |

Plan pricing (`BILLING_PLAN_{TIER}_{PERIOD}`) is in cents. Defaults: Developer free, Pro $7.99/mo, Unlimited $11.99/mo.

---

## AWS CDK / Lambda

| Variable | Default | Description |
|----------|---------|-------------|
| `LAMBDA_RUNTIME` | `nodejs24.x` | Lambda runtime |
| `LAMBDA_TIMEOUT` | `900` | Timeout (seconds) |
| `LAMBDA_MEMORY_SIZE` | `512` | Memory (MB) |
| `LAMBDA_ARCHITECTURE` | `ARM_64` | `ARM_64` or `x86_64` |
| `CODEBUILD_COMPUTE_TYPE` | `SMALL` | `SMALL`, `MEDIUM`, `LARGE`, `X2_LARGE` |
| `LOG_GROUP_NAME` | `/pipeline-builder/logs` | CloudWatch log group |
| `LOG_RETENTION` | `7` | Log retention (days) |
| `SECRETS_PATH_PREFIX` | `pipeline-builder` | AWS Secrets Manager path prefix |

---

## Timeouts

| Variable | Default | Description |
|----------|---------|-------------|
| `HANDLER_TIMEOUT_MS` | `25000` | Global HTTP request timeout (25s) |
| `PLUGIN_UPLOAD_TIMEOUT_MS` | `300000` | Upload route timeout override (5 min) |
| `DOCKER_BUILD_TIMEOUT_MS` | `900000` | Docker build timeout (15 min) |
| `DOCKER_PUSH_TIMEOUT_MS` | `300000` | Docker push timeout (5 min) |
| `SERVICE_TIMEOUT` | `30000` | Inter-service HTTP call timeout |
| `HTTP_CLIENT_TIMEOUT` | `5000` | Internal HTTP client timeout |
| `HTTP_CLIENT_MAX_RETRIES` | `2` | Internal HTTP client retries |
| `HTTP_CLIENT_RETRY_DELAY_MS` | `200` | Internal HTTP client retry delay |
| `QUOTA_SERVICE_TIMEOUT` | `5000` | Quota service call timeout |
| `BILLING_SERVICE_TIMEOUT` | `5000` | Billing service call timeout |

### Plugin Upload Timeout Chain

When uploading a large plugin ZIP (up to 4GB with prebuilt image.tar), the request passes through multiple timeout layers. Each layer must allow enough time for the upload to complete:

```
Client (curl)                    UPLOAD_TIMEOUT = 900s (15 min)
  └─ nginx proxy_read_timeout    60s (default) — increase for large uploads
      └─ Express route           PLUGIN_UPLOAD_TIMEOUT_MS = 300s (5 min)
          └─ Express global      HANDLER_TIMEOUT_MS = 25s (overridden by route)
              └─ Build queue     DOCKER_BUILD_TIMEOUT_MS = 900s (15 min, async)
                  └─ Push        DOCKER_PUSH_TIMEOUT_MS = 300s (5 min, async)
```

The upload request returns `202 Accepted` after the ZIP is parsed and the build job is enqueued. The Docker build and push happen asynchronously in the build queue — their timeouts do not affect the upload response.

**If uploads fail with 503 (timeout):** Increase `PLUGIN_UPLOAD_TIMEOUT_MS` and ensure nginx `proxy_read_timeout` is at least as long. Do not increase `HANDLER_TIMEOUT_MS` — it applies globally to all routes.

---

## Caching

| Variable | Default | Description |
|----------|---------|-------------|
| `CACHE_TTL_ENTITY` | `60` | Entity cache TTL (seconds) |
| `CACHE_TTL_MESSAGE` | `300` | Message cache TTL (seconds) |
| `CACHE_TTL_REPORT_INVENTORY` | `300` | Report inventory cache TTL (seconds) |
| `CACHE_TTL_REPORT_TIMESERIES` | `120` | Report timeseries cache TTL (seconds) |
| `CACHE_TTL_COMPLIANCE_RULES` | `60` | Compliance rules cache TTL (seconds) |
| `CACHE_TTL_BILLING_PLANS` | `14400` | Billing plans cache TTL (4 hours) |
| `CACHE_CLEANUP_INTERVAL_MS` | `30000` | Cache cleanup interval (30s) |

---

## Server-Sent Events

| Variable | Default | Description |
|----------|---------|-------------|
| `SSE_MAX_CLIENTS_PER_REQUEST` | `10` | Max SSE clients per request ID |
| `SSE_CLIENT_TIMEOUT_MS` | `1800000` | SSE client timeout (30 min) |
| `SSE_CLEANUP_INTERVAL_MS` | `300000` | SSE cleanup interval (5 min) |
| `SSE_STREAM_TIMEOUT_MS` | `300000` | SSE stream timeout (5 min) |
| `SSE_BACKPRESSURE_THRESHOLD` | `10` | SSE backpressure threshold |

---

## Admin UIs (Infrastructure)

These variables configure infrastructure admin tools, not application code.

| Variable | Default | Description |
|----------|---------|-------------|
| `PGADMIN_DEFAULT_EMAIL` | `admin@pipeline.dev` | pgAdmin login email |
| `PGADMIN_DEFAULT_PASSWORD` | — | pgAdmin login password |
| `ME_CONFIG_BASICAUTH_USERNAME` | `admin` | Mongo Express username |
| `ME_CONFIG_BASICAUTH_PASSWORD` | — | Mongo Express password |

---

## Pagination & Limits

| Variable | Default | Description |
|----------|---------|-------------|
| `MAX_PAGE_LIMIT` | `1000` | Max page size |
| `DEFAULT_PAGE_LIMIT` | `100` | Default page size |
| `MAX_PROMPT_LENGTH` | `5000` | Max AI prompt length |
| `MAX_BULK_ITEMS` | `100` | Max items per bulk operation |
| `MAX_EVENTS_PER_BATCH` | `100` | Max events per batch ingestion |
| `INVITATION_EXPIRATION_DAYS` | `7` | Org invitation expiry |
| `INVITATION_MAX_PENDING_PER_ORG` | `50` | Max pending invitations per org |

---

## AI Providers (Optional)

| Variable | Description |
|----------|-------------|
| `ANTHROPIC_API_KEY` | Anthropic API key |
| `OPENAI_API_KEY` | OpenAI API key |
| `GOOGLE_GENERATIVE_AI_API_KEY` | Google AI API key |
| `XAI_API_KEY` | xAI API key |

At least one provider key is required for AI-powered pipeline and plugin generation. See the [AI plugins documentation](plugins/ai.md) for details on supported providers and models.
