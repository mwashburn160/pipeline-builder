---
layout: default
title: Environment Variables
---

# Environment Variables

Complete reference for all environment variables used across Pipeline Builder services. Each variable can be set in your `.env` file or passed directly via your deployment configuration (Docker Compose, Kubernetes ConfigMap, ECS task definition).

**Quick setup:** Each deploy target ships its own template (`deploy/local/docker/.env.example`, `deploy/local/minikube/.env.example`, `deploy/aws/ec2/.env.example`, `deploy/aws/eks/.env.example`). Copy the one for your target to `.env` and fill in the required secrets.

> **Security:** Generate JWT secrets with `openssl rand -base64 32`. Never commit `.env` files to version control.

**Related docs:** [AWS Deployment](aws-deployment.md) | [API Reference](api-reference.md)

---

## Overview

This reference documents every environment variable across the Pipeline Builder services, grouped by concern (core, authentication, databases, plugin builds, quotas, compliance, email, billing, AWS/Lambda, timeouts, caching, and more) with each variable's default and effect. It's for anyone deploying or operating the platform; pair it with the per-target `.env.example` templates noted above and set only what your target needs. Defaults mirror the code, and feature switches are called out where they interact — for example the billing master switch `BILLING_DISCOUNTS_ENABLED` and the per-tier `QUOTA_TIER_*` / `JWT_EXPIRES_IN_*` overrides. Use the [Table of Contents](#table-of-contents) below to jump to a section.

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
- [Reporting & DORA](#reporting--dora) -- Event reporting, DORA metrics, retention
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
| `SYSTEM_ORG_ID` | `000000000000000000000001` | ObjectId of the well-known system tenant (the org with `slug:'system'` + `isSystem:true`). Lowercased at module load and compared case-insensitively. **If you override it, you must mirror the new value in the Postgres RLS policy** (`deploy/**/postgres-init.sql` hardcodes `000000000000000000000001` as the always-visible system org), or system-org content becomes invisible to other orgs. |

---

## Authentication

| Variable | Default | Description |
|----------|---------|-------------|
| `JWT_SECRET` | — | **Required.** JWT signing secret. Must be **identical across all services** — `signServiceToken()` mints inter-service tokens with this same secret so any service's `requireAuth` can verify them. |
| `REFRESH_TOKEN_SECRET` | — | **Required.** Refresh token secret |
| `JWT_EXPIRES_IN` | `900` | Access-token TTL in seconds (15 min) at the platform auth issuer — deliberately short so privilege changes take effect quickly (paired with `tokenVersion` revocation). Per-tier overrides take precedence. (The generic pipeline-core server scaffold falls back to `7200` where it isn't the token issuer.) |
| `JWT_EXPIRES_IN_DEVELOPER` | (inherits `JWT_EXPIRES_IN`) | Developer-tier access-token TTL override |
| `JWT_EXPIRES_IN_PRO` | (inherits `JWT_EXPIRES_IN`) | Pro-tier override — commonly shorter for compliance |
| `JWT_EXPIRES_IN_TEAM` | (inherits `JWT_EXPIRES_IN`) | Team-tier override |
| `JWT_EXPIRES_IN_ENTERPRISE` | (inherits `JWT_EXPIRES_IN`) | Enterprise-tier override (e.g. `1800` = 30 min) |
| `JWT_EXPIRES_IN_UNLIMITED` | (inherits `JWT_EXPIRES_IN`) | Unlimited-tier override (billing-disabled default tier) |
| `JWT_ALGORITHM` | `HS256` | `HS256`, `HS384`, `HS512`, `RS256` |
| `BCRYPT_SALT_ROUNDS` | `12` | bcrypt cost factor for password hashing (10-12 recommended). |
| `REFRESH_TOKEN_EXPIRES_IN` | `2592000` | Refresh token TTL (30d) |
| `PASSWORD_MIN_LENGTH` | `8` | Minimum password length |
| `COOKIE_SAME_SITE` | `lax` | `lax`, `strict`, or `none` for refresh cookie |
| `COOKIE_SECURE` | `false` (auto-true in prod) | Set `true` to force the `secure` cookie flag; auto-enabled when `NODE_ENV=production` |
| `BOOTSTRAP_SUPERADMIN_EMAILS` | — | Comma-separated user emails auto-promoted to `isSuperAdmin=true` at platform boot. **Required for fresh installs** — the first sysadmin can only be granted through this env or a direct DB update. Idempotent. |

### Multi-team secret encryption

AI provider keys and IdP client secrets are encrypted at rest. `SECRET_ENCRYPTION_KEY` is **required at platform boot** — the read paths do not fall back to clear text; a non-encrypted value throws on read. Rotating an org's KMS config re-encrypts that org's secrets under the new key (see the org KMS-config admin endpoint).

| Variable | Default | Description |
|----------|---------|-------------|
| `SECRET_ENCRYPTION_KEY` | — | **Required.** 32-byte master key (hex or base64). Generate with `head -c 32 /dev/urandom \| base64`. Platform aborts startup when this is unset in production. |
| `SECRET_ENCRYPTION_PER_ORG_KMS` | `false` | When `true`, each org's secrets are wrapped under its own KMS CMK (see `Organization.kmsConfig`). Orgs without an entry fall through to the shared master. Recommended for SOC2 / compliance deploys. |
| `SECRET_ENCRYPTION_KMS_KEY_ID` | — | (Single-master KMS mode) KMS CMK alias / ARN used to wrap the shared master. |
| `SECRET_ENCRYPTION_KMS_CIPHERTEXT` | — | (Single-master KMS mode) Base64 KMS-wrapped 32-byte master. |

### Multi-team RLS context

| Variable | Default | Description |
|----------|---------|-------------|
| `RLS_CONTEXT_MODE` | `warn` | Behavior when `withTenantTx` is called outside any tenant scope. `warn` logs a stack-traced warning, `strict` throws, `silent` is no-op (tests / migration only). Recommended production rollout: `warn` for ≥7 days, then flip to `strict` after the logs show zero spurious warnings. |

### Multi-team alert webhook relay

| Variable | Default | Description |
|----------|---------|-------------|
| `ALERT_WEBHOOK_INSTANCES` | — | JSON array of `{ id, token, allowedOrgIds? }` entries. **Required** to enable the relay; unset / empty returns 503 at the webhook endpoint. Each Alertmanager sends `X-Alertmanager-Instance: <id>` + `Authorization: Bearer <token>`. `allowedOrgIds` restricts which orgs that instance can relay alerts for. |
| `ALERT_WEBHOOK_INSTANCE_ID` | — | (Alertmanager side) The id of this Alertmanager's entry. |
| `ALERT_WEBHOOK_INSTANCE_TOKEN` | — | (Alertmanager side) The matching token. |

### OAuth / social login (Optional)

Platform-wide "Sign in with…" providers. A provider is **enabled iff its
`OAUTH_<P>_CLIENT_ID` is set** (fail-soft — an unconfigured provider is hidden,
never an error); the login page renders its buttons data-driven from the enabled
set. Credentials are **global / one app registration per provider** for the whole
deployment. The redirect URI to register in each provider's console is
`<OAUTH_CALLBACK_BASE_URL>/auth/callback/<provider>`. Per-org enterprise SSO
(OIDC / Cognito) is configured **in the app**, not here — see
[Authentication & SSO](authentication.md).

**Shared:**

| Variable | Default | Description |
|----------|---------|-------------|
| `OAUTH_CALLBACK_BASE_URL` | `${PLATFORM_FRONTEND_URL}` | OAuth redirect origin (each handler appends `/auth/callback/<provider>`) |
| `OAUTH_STATE_TTL_MS` | `600000` | OAuth state (CSRF) token TTL (10 min) |
| `OAUTH_CLEANUP_INTERVAL_MS` | `60000` | Stale state cleanup interval |

**Per provider** (`CLIENT_ID` empty = disabled):

| Variable | Default | Description |
|----------|---------|-------------|
| `OAUTH_GOOGLE_CLIENT_ID` | — | Google client ID ([Google Cloud Console](https://console.cloud.google.com/apis/credentials)) |
| `OAUTH_GOOGLE_CLIENT_SECRET` | — | Google client secret |
| `OAUTH_GITHUB_CLIENT_ID` | — | GitHub client ID ([GitHub OAuth Apps](https://github.com/settings/developers)) |
| `OAUTH_GITHUB_CLIENT_SECRET` | — | GitHub client secret |
| `OAUTH_FACEBOOK_CLIENT_ID` | — | Facebook app ID ([Meta for Developers](https://developers.facebook.com/apps)) |
| `OAUTH_FACEBOOK_CLIENT_SECRET` | — | Facebook app secret |
| `OAUTH_MICROSOFT_CLIENT_ID` | — | Microsoft/Entra client ID ([Entra admin center](https://entra.microsoft.com) → App registrations) |
| `OAUTH_MICROSOFT_CLIENT_SECRET` | — | Microsoft/Entra client secret |
| `OAUTH_MICROSOFT_TENANT` | `common` | Entra tenant: `common` (any account) or a specific tenant id/domain |
| `OAUTH_GITLAB_CLIENT_ID` | — | GitLab application ID ([GitLab Applications](https://gitlab.com/-/profile/applications)) |
| `OAUTH_GITLAB_CLIENT_SECRET` | — | GitLab application secret |
| `OAUTH_GITLAB_BASE_URL` | `https://gitlab.com` | GitLab base URL (point at a self-hosted instance to use it) |
| `OAUTH_LINKEDIN_CLIENT_ID` | — | LinkedIn client ID ([LinkedIn Developers](https://www.linkedin.com/developers/apps), "Sign in with LinkedIn using OpenID Connect") |
| `OAUTH_LINKEDIN_CLIENT_SECRET` | — | LinkedIn client secret |

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
| `REDIS_URL` | — | Full connection URL (takes precedence over HOST/PORT) |
| `REDIS_HOST` | `redis` | Hostname |
| `REDIS_PORT` | `6379` | Port |
| `REDIS_PASSWORD` | — | Data-node AUTH password (optional) |
| `REDIS_SENTINELS` | — | **HA:** comma-separated `host:port` Sentinel list. When set, the app connects via Sentinel and auto-fails-over to the promoted primary (HOST/PORT/URL ignored). Also the shape a managed ElastiCache (cluster-mode-disabled) uses. See [`deploy/aws/*/k8s/redis-sentinel.yaml`](https://github.com/mwashburn160/pipeline-builder/blob/main/deploy/aws/eks/k8s/redis-sentinel.yaml) |
| `REDIS_SENTINEL_MASTER` | `mymaster` | Sentinel monitored-primary name (Sentinel mode) |
| `REDIS_SENTINEL_PASSWORD` | — | Sentinel AUTH password (Sentinel mode, optional) |

> Redis must use `maxmemory-policy noeviction` for BullMQ. `allkeys-lru` causes silent job data loss.
> **HA:** the shipped in-cluster Redis is single-instance (no failover). For HA, apply the `redis-sentinel.yaml` template (3 Redis + 3 Sentinel) and set `REDIS_SENTINELS`, or point it at a managed **ElastiCache (Multi-AZ, cluster-mode-disabled)** — the recommended production path.

---

## Docker Registry

| Variable | Default | Description |
|----------|---------|-------------|
| `IMAGE_REGISTRY_HOST` | `registry` | Registry hostname |
| `IMAGE_REGISTRY_PORT` | `5000` | Registry port |
| `IMAGE_REGISTRY_USER` | `admin` | Registry username |
| `IMAGE_REGISTRY_TOKEN` | — | Registry password/token |
| `IMAGE_REGISTRY_HTTP` | `true` | Plugin builds talk to the in-cluster registry over plain HTTP. Set `false` only if the registry is exposed via a TLS-terminating proxy with a publicly trusted cert. |
| `IMAGE_REGISTRY_TOKEN_REALM` | `${PLATFORM_BASE_URL}/image-registry/token` | Bearer-token realm the plugin keys its registry credential under. **Must match the registry's `REGISTRY_AUTH_TOKEN_REALM`** (e.g. `http://image-registry:3000/token` in-cluster) — when the registry redirects a push to a different host than the push target, the plugin only sends Basic auth if it has a credential keyed under that realm host. Set on every target's plugin so pushes don't 401 / `insufficient_scope`. |

---

## Plugin Builds

Every deploy target (EKS, EC2, minikube, local docker-compose) runs
plugin builds against a **rootless `moby/buildkit` sidecar (`buildkitd`)**. The
plugin service's `buildctl` connects via the Unix socket exposed by the sidecar —
there is no docker daemon, no privileged build sidecar, and no strategy switch.

| Variable | Default | Description |
|----------|---------|-------------|
| `BUILDKIT_HOST` | `unix:///run/buildkit/buildkitd.sock` | buildctl `--addr` for the buildkitd sidecar |
| `DOCKER_BUILD_TIMEOUT_MS` | `900000` | Build timeout (15 min) |
| `DOCKER_PUSH_TIMEOUT_MS` | `300000` | Push timeout (5 min) |
| `PLUGIN_UPLOAD_TIMEOUT_MS` | `300000` | Upload HTTP timeout (5 min) — overrides `HANDLER_TIMEOUT_MS` for the upload route |
| `PLUGIN_MAX_UPLOAD_MB` | `4096` | Max plugin ZIP upload size in MB (supports prebuilt image.tar) |

The plugin image is published with a single tag (`plugin:<version>`) — one
builder, one path, no per-builder target suffixes.

### How the build runs

- **Build from source** (`buildType: build_image`): `buildctl build --frontend dockerfile.v0 --local context=<dir> --local dockerfile=<dir> --output type=image,name=<image>,push=true[,registry.insecure=true]`. buildkitd handles the Dockerfile parse, layer cache, registry push, and bearer-token negotiation.
- **Prebuilt tarball** (`buildType: prebuilt`): `crane push <tar> <image>`. buildctl can build but cannot push pre-existing `docker save` tarballs; the plugin image bundles `crane` for this path only.

### Why rootless BuildKit

- **Rootless, no privileged containers**: `moby/buildkit:rootless` runs as uid 1000 with no `SYS_ADMIN` and no `privileged: true` — it builds full OCI images from a Dockerfile **without a Docker daemon and without a docker socket mount**, removing the classic dind/socket attack surface.
- **Builds and pushes directly**: buildkitd parses the Dockerfile, runs the build with native **layer caching**, and **pushes straight to the registry** (`--output type=image,push=true`) — no intermediate `docker save`/`docker push` round-trip.
- **No CA-trust workarounds**: buildkitd carries the system CA bundle and follows realm-URL bearer challenges with the host's trust store — no per-container cert mounts, no `update-ca-certificates` shell wrappers.
- **One code path everywhere**: the same `docker-build.ts` runs on EKS, EC2, minikube, and local. Deploy target only changes the sidecar's hosting (k8s pod / compose service).

### Build Queue

| Variable | Default | Description |
|----------|---------|-------------|
| `PLUGIN_BUILD_CONCURRENCY` | `1` | Max concurrent builds per container (per-tier overrides: `PLUGIN_BUILD_CONCURRENCY_<DEVELOPER\|PRO\|TEAM\|ENTERPRISE\|UNLIMITED>`) |
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
| `MESSAGE_SEND_RATE_MAX` | `60` | Per-**org** message send + reply limit (post-auth; complements the global per-IP limiter). Verified service principals exempt |
| `MESSAGE_SEND_RATE_WINDOW_MS` | `60000` | Per-org message-send window (1 min) |
| `MESSAGE_ATTACHMENT_RATE_MAX` | `30` | Per-**org** attachment-upload limit (rejected before multipart buffering) |
| `MESSAGE_ATTACHMENT_RATE_WINDOW_MS` | `60000` | Per-org attachment-upload window (1 min) |
| `MESSAGE_THUMBNAIL_MAX_DIM` | `320` | Long-edge (px) of generated image thumbnails (pure-JS jimp; served via `?thumb=1`, falls back to the original) |
| `LIMITER_MULT_DEVELOPER` | `1` | Developer-tier rate-limit multiplier (budget = `LIMITER_MAX` × mult) |
| `LIMITER_MULT_PRO` | `10` | Pro-tier rate-limit multiplier |
| `LIMITER_MULT_TEAM` | `25` | Team-tier rate-limit multiplier |
| `LIMITER_MULT_ENTERPRISE` | `50` | Enterprise-tier rate-limit multiplier |
| `LIMITER_MULT_UNLIMITED` | `100` | Unlimited-tier rate-limit multiplier (billing-disabled default tier) |

Tier presets ship in `@pipeline-builder/api-core` (`QUOTA_TIERS` in `quota-tiers.ts`):

| Tier | plugins | pipelines | apiCalls | aiCalls | seats |
|------|---------|-----------|----------|---------|-------|
| developer | 25 | 5 | 25,000 | 25 | 1 |
| pro | 50 | 10 | 500,000 | 1,000 | 1 |
| team | 100 | 200 | 2,000,000 | 5,000 | 10 |
| enterprise | 250 | 200 | 10,000,000 | 15,000 | 25 |
| unlimited | -1 | -1 | -1 | -1 | -1 |

Any preset can be overridden per-environment via `QUOTA_TIER_<DEVELOPER|PRO|TEAM|ENTERPRISE|UNLIMITED>_<LIMIT>` (e.g. `QUOTA_TIER_TEAM_SEATS=20`), and `DEFAULT_QUOTA_TIER` sets the tier assigned to newly created orgs (`developer` by default). `seats` is a tier limit, not a tracked counter — it is enforced live at invite time against active org membership.

**`unlimited` tier.** Every limit is `-1` (uncapped) and every gated feature is on. It is the automatic default when **billing is disabled** (`BILLING_ENABLED=false`) — `DEFAULT_QUOTA_TIER` is ignored in that case and new orgs get `unlimited`. When billing is **enabled** it is never displayed, selectable, or purchasable (excluded from the plans list and tier pickers), and `DEFAULT_QUOTA_TIER=unlimited` is rejected in favour of `developer`. Its label is overridable via `QUOTA_TIER_UNLIMITED_LABEL` (default `Unlimited`).

Each tier's quota **reset period** is overridable via `QUOTA_TIER_<TIER>_RESET_PERIOD` (a single duration applied to every quota type). Defaults: `3days` for developer/pro, `30days` for team/enterprise. (The reset period is moot for `unlimited`, whose limits are all `-1` and never reset.)

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
| `PLATFORM_SERVICE_HOST` | `platform` | Platform service hostname (compliance → email delivery) |
| `PLATFORM_SERVICE_PORT` | `3000` | Platform service port |
| `COMPLIANCE_SERVICE_HOST` | `compliance` | Compliance service hostname (also billing → compliance entitlement sync) |
| `COMPLIANCE_SERVICE_PORT` | `3000` | Compliance service port |
| `BILLING_SERVICE_HOST` | `billing` | Billing service hostname |
| `BILLING_SERVICE_PORT` | `3000` | Billing service port |
| `QUOTA_SERVICE_HOST` | `quota` | Quota service hostname |
| `QUOTA_SERVICE_PORT` | `3000` | Quota service port |

---

## Messaging & Attachments

The message service backs in-app messaging: system announcements (broadcast to every org), org-to-org conversations, support threads, and **per-user direct messages** (a conversation targeted at a single user within the recipient org via `recipientUserId` — only that user, plus the sender org and system org, can see it). Messages may carry file/image **attachments**, stored in S3-compatible object storage (MinIO by default).

| Variable | Default | Description |
|----------|---------|-------------|
| `SUPPORT_ALIASES` | `support@pipeline-builder,help@pipeline-builder` | Comma-separated support inbox aliases. Any of them resolves to the system support org on send; the compose recipient picker lists **all** of them as suggestions (the first is the primary, prefilled default). |
| `S3_ENDPOINT` | `http://minio:9000` | S3-compatible endpoint for attachment storage. Empty ⇒ default AWS S3 (no custom endpoint). |
| `S3_BUCKET` | `message-attachments` | Bucket for attachment blobs (auto-created on first upload). |
| `S3_REGION` | `us-east-1` | S3 region. |
| `S3_ACCESS_KEY_ID` | `message-svc` | Per-service, bucket-scoped access key (created by the `minio-init` bootstrap — not the MinIO root creds). |
| `S3_SECRET_ACCESS_KEY` | `message-svc-secret` | Secret key. **Change for any real deployment.** |
| `S3_FORCE_PATH_STYLE` | `true` | Path-style addressing (required by MinIO; harmless for real S3). |
| `MESSAGE_ATTACHMENT_MAX_MB` | `10` | Max attachment size (MiB). Uploads over this are rejected `413`. |

> MinIO backs more than attachments now: the **container registry** (S3 storage driver), **Loki** (log chunks + index), and **Thanos** (Prometheus long-term blocks) each use their own bucket + a per-service, bucket-scoped key (`registry-svc` / `loki-svc` / `thanos-svc`), all created by the `minio-init` bootstrap. See **[Deploy Operations → Object storage (MinIO)](deploy-operations.md#object-storage-minio)** for the bucket table + HA topology (distributed StatefulSet on EKS, SNMD on ec2, single-drive on docker/minikube).

Attachments are validated against a MIME allow-list (common images + documents; no executables/scripts/HTML). Downloads are auth-gated and inherit the parent message's visibility, so a per-user targeted message's attachment stays private to its target. Blobs are reclaimed when a message is hard-purged by the retention sweep.

---

## Compliance

| Variable | Default | Description |
|----------|---------|-------------|
| `COMPLIANCE_BYPASS` | `false` | Bypass compliance checks when service is unavailable (dev/DR only) |
| `COMPLIANCE_ENABLED` | `true` | Enable compliance enforcement |
| `SCAN_SCHEDULER_INTERVAL_MS` | `60000` | Compliance scan scheduler interval (ms) |
| `SYSTEM_ORG_SCANS_ENABLED` | `false` | Run scheduled scans for the system org too |
| `SCAN_LOCK_TTL_MS` | `300000` | Scan scheduler cross-pod leader-lock TTL (ms); only one replica sweeps per tick |
| `DIGEST_SCHEDULER_INTERVAL_MS` | `3600000` | How often the notification digest scheduler checks for due daily/weekly digests (ms) |
| `DIGEST_LOCK_TTL_MS` | `300000` | Digest scheduler cross-pod leader-lock TTL (ms) |

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
| `BILLING_ENABLED` | `true` | Enable billing (opt-out — on unless set to `false`). When `false`, new orgs default to the uncapped `unlimited` tier and no plans/tiers are offered; when `true`, `unlimited` is hidden and orgs get `DEFAULT_QUOTA_TIER` (default `developer`). |
| `BILLING_PROVIDER` | `stub` | `stub`, `aws-marketplace`, or `stripe` |
| `BILLING_SERVICE_HOST` | `billing` | Service hostname |
| `BILLING_SERVICE_PORT` | `3000` | Service port |
| `BILLING_LIFECYCLE_CHECK_INTERVAL_MS` | `3600000` | Subscription lifecycle check interval (1 hour) |
| `PAYMENT_GRACE_PERIOD_DAYS` | `7` | Grace period for overdue payments |
| `RENEWAL_REMINDER_DAYS` | `7` | Days before expiry to send renewal reminder |
| `BILLING_BUNDLES_ENABLED` | `false` | Master switch for purchasable [add-on bundles](billing-bundles.md) — hidden unless set |

Plan pricing (`BILLING_PLAN_{TIER}_MONTHLY` / `BILLING_PLAN_{TIER}_ANNUAL`, where `{TIER}` is `DEVELOPER`, `PRO`, `TEAM`, or `ENTERPRISE`) is in cents. Defaults: Developer free, Pro $49/mo ($490/yr), Team $149/mo ($1,490/yr), Enterprise $599/mo ($5,990/yr). Per-plan `_NAME` (display name), `_DESCRIPTION` (string), and `_FEATURES` (JSON array) can also be overridden.

An `UNLIMITED` plan (free, `BILLING_PLAN_UNLIMITED_NAME` default `Unlimited`) is also seeded so the billing store has a row for orgs on the billing-disabled default tier, but it is filtered out of the customer-facing plans list — it is never sold or shown when billing is enabled.

Add-on bundles are env-tunable (see [Billing Add-on Bundles → Overrides](billing-bundles.md#configuration--overrides)): `BILLING_BUNDLE_<ID>_MONTHLY` / `_ANNUAL` (price, cents), `BILLING_BUNDLE_<ID>_GRANT` (single-dimension grant amount), and `BILLING_BUNDLE_<ID>_TIERS` (JSON array of purchasable tiers), where `<ID>` is the bundle id upper-cased (`SEAT_PACK`, `PIPELINE_PACK`, `PLUGIN_PACK`, `API_PACK`, `AI_PACK`, `STORAGE_PACK`, `RETENTION_PACK`, `DORA_HISTORY_PACK`, `AUDIT_LOG`, `SSO`, `ADVANCED_REPORTING`, `TEAM_USAGE_ANALYTICS`, `COMPLIANCE_STANDARD`, `COMPLIANCE_ADVANCED`). Combo prices are `BILLING_COMBO_<COMBO>_MONTHLY` / `_ANNUAL` where `<COMBO>` is `ANALYTICS_SUITE`, `TEAM_GROWTH`, or `COMPLIANCE_SUITE`. The retention packs default to $15/mo ($150/yr, `RETENTION_PACK`) and $30/mo ($300/yr, `DORA_HISTORY_PACK`); under AWS Marketplace they meter as the `RetentionPack` / `DoraHistoryPack` dimensions (see `AWS_MARKETPLACE_BUNDLE_DIMENSION_MAP`).

The compliance content add-ons default to $29.90/mo ($299/yr, `COMPLIANCE_STANDARD`) and $99.90/mo ($999/yr, `COMPLIANCE_ADVANCED`, which requires Standard), with the `COMPLIANCE_SUITE` combo (both, 30% off) at $90.86/mo ($908.60/yr) — see [Compliance → Curated content add-ons](compliance.md#curated-content-add-ons-standard--advanced). On every entitlement change (purchase/cancel/renewal) billing pushes the org's entitled content sets to the compliance service (`PUT /api/compliance/entitlements/:orgId`, which auto-subscribes/activates on gain and deactivates on loss), reaching it via `COMPLIANCE_SERVICE_HOST` / `COMPLIANCE_SERVICE_PORT` (Service Discovery, above).

### Discounts

Discount codes + usage credits ([docs/billing-discounts.md](billing-discounts.md)) — Stripe only, on by default.

| Variable | Default | Description |
|----------|---------|-------------|
| `BILLING_DISCOUNTS_ENABLED` | `true` | Master switch — set `false` to 404 the discount routes. Also governs Marketplace metered-credit realization (same value for both providers) |
| `BILLING_DISCOUNT_KEYS` | — | **Secret.** AES-256-GCM signing keys for discount tokens, `v1:<base64-32B>,v2:…`; the highest version mints, older keys still decode (rotation). Required to issue Mode-B tokens |
| `BILLING_DISCOUNT_MAX_PERCENT` | `100` | Mint-time ceiling on a percent discount (1-100) |
| `BILLING_DISCOUNT_MAX_CENTS` | `10000000` | Mint-time ceiling on a dollar/credit discount, in cents ($100k) |
| `BILLING_PROMOTIONS_ENABLED` | `true` | Master switch for [promotions](billing-discounts.md#promotions) (rule-driven auto-grant campaigns). Same opt-out default as `BILLING_DISCOUNTS_ENABLED` (on unless set to `false`). Additionally requires `BILLING_DISCOUNTS_ENABLED` (shared usage-credit machinery), so discounts off ⇒ promotions off; the routes 404 and the auto-grant engine no-ops when off |
| `BILLING_PROMOTION_BACKFILL_INTERVAL_MS` | `3600000` | Backfill-cron cadence (1h). Re-scans eligible-but-ungranted orgs so a transient failure or a late-activated campaign still lands. Leader-locked; idempotent |
| `BILLING_PROMOTION_CLAWBACK_WINDOW_MS` | `604800000` | Clawback window (7d). A promotion grant is reversed (ledger row pulled, balance reduced, budget released) if the subscription cancels within this window of the grant — defuses signup-grab-churn |

`BILLING_DISCOUNT_KEYS` is a secret — provision it via a sealed secret / SSM, never commit a real value. Losing it makes previously issued Mode-B tokens undecodable (already-applied discounts on subscriptions are unaffected).

### AWS Marketplace metering & credit realization

For `BILLING_PROVIDER=aws-marketplace`: add-on charges are reported as metered usage, and usage-credit discounts realize by **withholding** metered units (see [docs/billing-discounts.md](billing-discounts.md#aws-marketplace--private-offers-handled-in-aws-not-in-app)). Metering is **default-off** and the two switches (`BILLING_DISCOUNTS_ENABLED` + `BILLING_METERING_ENABLED`) must both be on before a Marketplace credit is accepted — otherwise a credit would bank but never reduce the AWS bill.

| Variable | Default | Description |
|----------|---------|-------------|
| `BILLING_METERING_ENABLED` | `false` | Run the metering cycle (report add-on usage + realize credits). Off = no metering, and Marketplace credits are rejected |
| `BILLING_METERING_INTERVAL_MS` | `3600000` | Metering cycle cadence (1 hour). AWS `BatchMeterUsage` dedupes by (customer, dimension, hour) |
| `BILLING_METERING_DRAWDOWN_DRYRUN` | `false` | Shadow mode — compute + log the intended credit withholding but report FULL quantities and leave the balance untouched. Validate the price map before going live |
| `AWS_MARKETPLACE_PRODUCT_CODE` | — | The Marketplace product code |
| `AWS_MARKETPLACE_REGION` | `AWS_REGION` or `us-east-1` | Region for the Metering/Entitlement clients |
| `AWS_MARKETPLACE_SNS_TOPIC_ARN` | — | SNS topic for entitlement/subscription notifications |
| `AWS_MARKETPLACE_DIMENSION_MAP` | identity | JSON map of Marketplace dimension → local plan id |
| `AWS_MARKETPLACE_BUNDLE_DIMENSION_MAP` | identity | JSON map of add-on bundle id → metered dimension key |
| `AWS_MARKETPLACE_DIMENSION_PRICE_MAP` | `{}` | JSON map of metered dimension → local list price in **cents per metered unit per metering cycle** (cycle = `BILLING_METERING_INTERVAL_MS`). Drives the credit drawdown; an unpriced dimension is never drawn against (reported in full). **A wrong value directly mis-draws credit** — mirror it to your AWS listing and cadence |

> **Money-movement caution:** the credit drawdown is real billing behavior. Keep `BILLING_METERING_ENABLED=false` until `AWS_MARKETPLACE_DIMENSION_PRICE_MAP` is validated (use the dry-run), and note that withholding offsets **metered add-on usage only** — plan-level reductions belong to AWS Marketplace private offers.

---

## Reporting & DORA

Event reporting (`setup-events` → the reporting service) and DORA metrics. All are **optional** — the platform runs on the defaults. DORA metrics sit behind the `advanced_reporting` entitlement; see [DORA Metrics](dora-metrics.md). Retention windows are **tier-aware and bundle-extendable** (effective window = tier baseline + Σ retention-pack grant, computed by billing and synced into `dora_settings`) and additionally **per-organization** overridable via the org's reporting settings; the `REPORTING_*` values below are the deployment-wide fallback used when neither a tier baseline nor an org override applies. The per-tier baselines are set by `QUOTA_TIER_<TIER>_EVENT_RETENTION_DAYS` / `QUOTA_TIER_<TIER>_DORA_RETENTION_DAYS` (see below).

| Variable | Default | Description |
|----------|---------|-------------|
| `DORA_ENABLED` | `false` | Set on the **event-ingestion Lambda** (not a service var) to enable DORA **lead-time** commit-range resolution in your AWS account (SCM calls + `github-token` read). Toggle via `pipeline-manager infra setup-events --with-dora`, not by hand. Off ⇒ standard reporting still works and DORA lead time reports `unknown`. |
| `DORA_INCIDENT_WINDOW_HOURS` | `24` | Reporting service. Window in which a production **incident** correlates to the most recent deploy (feeds post-deploy CFR / MTTR). Per-org override via `dora_settings`. |
| `REPORTING_RETENTION_ENABLED` | `true` | Master switch for the retention purge sweep. **Set `false` to keep all reporting history forever** — recommended for self-hosted / unlimited-tier deployments that want unbounded retention. |
| `REPORTING_EVENT_RETENTION_DAYS` | `30` | Retention (days) for **standard** pipeline events (non-deploy STAGE / ACTION / build). Older rows are purged by the sweep. Per-org override via `dora_settings`. |
| `REPORTING_DORA_RETENTION_DAYS` | `180` | Retention (days) for **DORA-source** records (deploy-stage events + deployment outcomes + incidents) — ~2 quarters. Per-org override via `dora_settings`. |
| `REPORTING_RETENTION_INTERVAL_HOURS` | `12` | How often the leader-locked retention sweep runs. |

The retention window is a **tier baseline** that add-on retention packs extend. Each tier's baseline is overridable per-environment:

| Variable | Default | Description |
|----------|---------|-------------|
| `QUOTA_TIER_<TIER>_EVENT_RETENTION_DAYS` | `30` (paid tiers) / unlimited on `unlimited` | Per-tier baseline retention (days) for **standard** pipeline events, where `<TIER>` is `DEVELOPER`, `PRO`, `TEAM`, `ENTERPRISE`, or `UNLIMITED`. The `unlimited` tier derives `-1` (unlimited — the sweep skips the org and keeps all history). The **Standard Retention Pack** add-on adds +90 days on top. |
| `QUOTA_TIER_<TIER>_DORA_RETENTION_DAYS` | `180` (paid tiers) / unlimited on `unlimited` | Per-tier baseline retention (days) for **DORA-source** records. The `unlimited` tier derives `-1`. The **DORA History Pack** add-on adds +365 days on top (and widens the report-query window to match). |

Billing computes the effective window (`tierBase + Σ pack grant`, `-1` = unlimited passthrough) and pushes it to the reporting service (`PUT /api/reports/retention-sync/:orgId`, writing `dora_settings`). The per-org report-query window tracks this effective retention (`min(730, orgRetentionDays)`, absolute ceiling **730 days**); an unlimited-tier org queries up to the 730-day ceiling.

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

## Scaling & multi-replica (Optional)

All optional (defaults shown). They tune behavior that matters only under horizontal scaling (>1 replica) or high load.

> **Redis is required for multi-replica correctness.** OAuth/SSO login CSRF `state` + nonce, SSE build-log delivery, the message service's SSE notification tickets (minted on one pod, redeemed on another), keyed-mutation idempotency (e.g. `POST /messages`), step-up single-use tokens, and the background sweep leader locks (org-purge, invitation-reaper, billing-reconcile, registry GC) all use the shared Redis when running with more than one replica. Without Redis they degrade to **per-pod** behavior, which is correct only on a single replica — e.g. round-robin between replicas would fail OAuth/SSO logins (`state`/`nonce` minted on one pod, validated on another), reject valid message-notification SSE connections (ticket minted on pod A, redeemed on pod B), and drop live build-log lines.

| Variable | Default | Description |
|----------|---------|-------------|
| `PIPELINE_EXEC_IDEMPOTENCY_WINDOW_SECONDS` | `60` | Window for the execution-trigger idempotency guard — a duplicate `POST /pipelines/:id/executions` within it is a no-op, not a second CodePipeline run |
| `BILLING_WEBHOOK_INPROGRESS_TTL_SECONDS` | `300` | Webhook in-progress lock TTL — a crash mid-processing releases the claim after this so the provider's retry re-runs the event's side-effects (not dropped as a duplicate) |
| `COMPLIANCE_VALIDATE_TIMEOUT_MS` | `4000` | Per-attempt timeout for the fail-closed compliance validate call (now retried, so a transient blip doesn't reject a legit upload/create) |
| `HTTP_CLIENT_MAX_SOCKETS` | `64` | Max sockets per internal HTTP keep-alive agent (was unbounded) |
| `REGISTRY_GC_LOCK_TTL_MS` | `900000` | Image-registry GC leader-lock TTL (ms); only one replica runs the destructive GC sweep at a time |

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
  └─ nginx proxy_read_timeout    900s (shipped configs); nginx's own default is 60s
      └─ Express route           PLUGIN_UPLOAD_TIMEOUT_MS = 300s (5 min)
          └─ Express global      HANDLER_TIMEOUT_MS = 25s (overridden by route)
              └─ Build queue     DOCKER_BUILD_TIMEOUT_MS = 900s (15 min, async)
                  └─ Push        DOCKER_PUSH_TIMEOUT_MS = 300s (5 min, async)
```

The upload request returns `202 Accepted` after the ZIP is parsed and the build job is enqueued. The Docker build and push happen asynchronously in the build queue — their timeouts do not affect the upload response.

**If uploads fail with 503 (timeout):** Increase `PLUGIN_UPLOAD_TIMEOUT_MS` and ensure nginx `proxy_read_timeout` is at least as long (the shipped nginx configs already set it to `900s` for the upload route). Do not increase `HANDLER_TIMEOUT_MS` — it applies globally to all routes.

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
| `SSE_MAX_TOTAL_TICKETS` | `1000` | Message service: cap on notification SSE tickets minted per TTL window across all orgs (Redis-backed when configured; abuse bound) |
| `SSE_MAX_TICKETS_PER_ORG` | `10` | Message service: per-org cap on notification SSE tickets minted per TTL window |

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
| `AI_PROVIDER` | (CLI `infra provision`) Provider to use: `anthropic` (default), `openai`, `google`, `xai`, `bedrock` |
| `AI_MODEL` | (CLI `infra provision`) Model id override (defaults to the provider's first model) |

At least one provider key is required for AI-powered pipeline and plugin generation. The same keys (plus the optional `AI_PROVIDER` / `AI_MODEL`) enable the `pipeline-manager infra provision` advisor's natural-language goal parsing and failure diagnosis; without a key, `infra provision` falls back to its deterministic prereq-check + command-assembly path. See the [AI plugins documentation](plugins/ai.md) for supported providers and models.
