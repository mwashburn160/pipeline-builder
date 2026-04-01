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
- [Plugin Builds](#plugin-builds) -- Build strategy, dind, queue config
- [Quotas & Rate Limiting](#quotas--rate-limiting) -- Per-org resource limits
- [Service Discovery](#service-discovery) -- Inter-service hostnames and ports
- [Compliance](#compliance) -- Compliance bypass and scan scheduling
- [Email](#email) -- SMTP and SES configuration
- [Billing](#billing) -- Subscription billing provider
- [AWS CDK / Lambda](#aws-cdk--lambda) -- Lambda runtime, CodeBuild compute
- [Admin UIs](#admin-uis) -- Grafana, pgAdmin, Mongo Express credentials
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

---

## Authentication

| Variable | Default | Description |
|----------|---------|-------------|
| `JWT_SECRET` | — | **Required.** JWT signing secret |
| `REFRESH_TOKEN_SECRET` | — | **Required.** Refresh token secret |
| `JWT_EXPIRES_IN` | `86400` | Token TTL in seconds (24h) |
| `JWT_ALGORITHM` | `HS256` | `HS256`, `HS384`, `HS512`, `RS256` |
| `JWT_SALT_ROUNDS` | `12` | bcrypt salt rounds |
| `REFRESH_TOKEN_EXPIRES_IN` | `2592000` | Refresh token TTL (30d) |
| `PASSWORD_MIN_LENGTH` | `12` | Minimum password length |
| `MAX_LOGIN_ATTEMPTS` | `5` | Lockout threshold |

### Google OAuth (Optional)

| Variable | Default | Description |
|----------|---------|-------------|
| `OAUTH_GOOGLE_CLIENT_ID` | — | Client ID (empty = disabled) |
| `OAUTH_GOOGLE_CLIENT_SECRET` | — | Client Secret |
| `OAUTH_CALLBACK_BASE_URL` | `${PLATFORM_FRONTEND_URL}` | OAuth redirect origin |

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
| `DB_MAX_RETRIES` | `3` | Connection retry attempts |
| `DB_RETRY_DELAY_MS` | `1000` | Retry delay (ms) |

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
| `DOCKER_REGISTRY_HTTP` | `false` | Use plain HTTP for registry push (no TLS) |
| `DOCKER_REGISTRY_INSECURE` | `true` | Skip TLS certificate verification |

---

## Plugin Builds

### Build Strategy

| Variable | Default | Description |
|----------|---------|-------------|
| `DOCKER_BUILD_STRATEGY` | `docker` | Build strategy: `docker` (dind sidecar, default for local/K8s), `podman` (daemonless), `kaniko` (daemonless, Fargate) |
| `DOCKER_BUILD_TIMEOUT_MS` | `900000` | Build timeout (15 min) |
| `DOCKER_PUSH_TIMEOUT_MS` | `300000` | Push timeout (5 min) |
| `PLUGIN_IMAGE_PREFIX` | `p-` | Image tag prefix |

The plugin Docker image is published with target-specific tags: `plugin:<version>-podman`, `plugin:<version>-kaniko`, `plugin:<version>-docker`. Each deploy target pulls the image matching its strategy.

### Strategy Details

| Strategy | How it works | Requires | Used by |
|----------|-------------|----------|---------|
| `docker` | Docker CLI connecting to a dind sidecar | `docker:27-dind` sidecar (privileged) | Local, Minikube, EC2 (default) |
| `podman` | Standard podman with `SYS_ADMIN` capability | Pod with `SYS_ADMIN`, `SETUID`, `SETGID` capabilities | Alternative for K8s |
| `kaniko` | Daemonless image builder | EFS mount for layer cache | Fargate (ECS) |

**Podman** runs as a standard (non-rootless) container build tool inside the plugin pod. The pod requires `SYS_ADMIN` capability for namespace creation and overlayfs mounts. No Docker daemon or sidecar needed.

**Docker (dind sidecar)** runs an isolated Docker daemon as a sidecar container. Plugin builds cannot see or affect host containers. The dind connection (`DOCKER_HOST`, `DOCKER_TLS_VERIFY`, `DOCKER_CERT_PATH`) is configured per-process by `docker-build.ts` at build time — do **not** set these in `.env` files as they override the host Docker CLI and break `docker compose`.

**Kaniko** builds images without a daemon or elevated privileges. Used on Fargate where privileged containers and podman are not available.

### Build Queue

| Variable | Default | Description |
|----------|---------|-------------|
| `PLUGIN_BUILD_CONCURRENCY` | `1` | Max concurrent builds per container |
| `PLUGIN_BUILD_QUEUE_NAME` | `plugin-build` | BullMQ queue name |
| `PLUGIN_BUILD_MAX_ATTEMPTS` | `2` | Max build attempts before moving to DLQ |
| `PLUGIN_DLQ_MAX_ATTEMPTS` | `3` | Max DLQ retry attempts (exponential backoff) |
| `PLUGIN_DLQ_BACKOFF_BASE_MS` | `300000` | DLQ backoff base delay (5 min; scales 5m → 15m → 45m) |
| `PLUGIN_DLQ_MAX_SIZE` | `20` | Max DLQ jobs before oldest are purged |

---

## Quotas & Rate Limiting

| Variable | Default | Description |
|----------|---------|-------------|
| `QUOTA_DEFAULT_PLUGINS` | `100` | Max plugins per org |
| `QUOTA_DEFAULT_PIPELINES` | `10` | Max pipelines per org |
| `QUOTA_DEFAULT_API_CALLS` | `-1` | Max API calls (`-1` = unlimited) |
| `QUOTA_RESET_DAYS` | `3` | Reset period (days) |
| `QUOTA_SERVICE_HOST` | `quota` | Quota service host |
| `QUOTA_SERVICE_PORT` | `3000` | Quota service port |
| `QUOTA_BYPASS_ORG_ID` | `system` | Org that bypasses all quotas |
| `LIMITER_MAX` | `100` | Global rate limit (requests/window) |
| `LIMITER_WINDOWMS` | `900000` | Global rate limit window (15 min) |

Per-operation limits follow the pattern `QUOTA_{ACTION}_{RESOURCE}_LIMIT` and `QUOTA_{ACTION}_{RESOURCE}_WINDOW_MS`.

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

---

## Compliance

| Variable | Default | Description |
|----------|---------|-------------|
| `COMPLIANCE_BYPASS` | `false` | Bypass compliance checks when service is unavailable (dev/DR only) |
| `SCAN_SCHEDULER_INTERVAL_MS` | `60000` | Compliance scan scheduler interval (ms) |

---

## Email

| Variable | Default | Description |
|----------|---------|-------------|
| `EMAIL_ENABLED` | `false` | Enable email sending |
| `EMAIL_FROM` | `noreply@example.com` | Sender address |
| `EMAIL_PROVIDER` | `smtp` | `smtp` or `ses` |
| `SMTP_HOST` | `localhost` | SMTP host |
| `SMTP_PORT` | `587` | SMTP port |
| `SMTP_USER` | — | SMTP username |
| `SMTP_PASS` | — | SMTP password |

For AWS SES: set `EMAIL_PROVIDER=ses` with `SES_REGION`, `SES_ACCESS_KEY_ID`, `SES_SECRET_ACCESS_KEY`.

---

## Billing

| Variable | Default | Description |
|----------|---------|-------------|
| `BILLING_ENABLED` | `false` | Enable billing |
| `BILLING_PROVIDER` | `stub` | `stub` or `aws-marketplace` |
| `BILLING_SERVICE_HOST` | `billing` | Service hostname |
| `BILLING_SERVICE_PORT` | `3000` | Service port |

Plan pricing (`BILLING_PLAN_{TIER}_{PERIOD}`) is in cents. Defaults: Developer free, Pro $7.99/mo, Unlimited $11.99/mo.

---

## AWS CDK / Lambda

| Variable | Default | Description |
|----------|---------|-------------|
| `LAMBDA_RUNTIME` | `nodejs24.x` | Lambda runtime |
| `LAMBDA_TIMEOUT` | `900` | Timeout (seconds) |
| `LAMBDA_MEMORY_SIZE` | `128` | Memory (MB) |
| `LAMBDA_ARCHITECTURE` | `ARM_64` | `ARM_64` or `x86_64` |
| `CODEBUILD_COMPUTE_TYPE` | `SMALL` | `SMALL`, `MEDIUM`, `LARGE`, `X2_LARGE` |
| `LOG_GROUP_NAME` | `/pipeline-builder/logs` | CloudWatch log group |
| `LOG_RETENTION` | `1` | Log retention (days) |

---

## Admin UIs

| Variable | Default | Description |
|----------|---------|-------------|
| `GRAFANA_ADMIN_USER` | `admin` | Grafana admin username |
| `GRAFANA_ADMIN_PASSWORD` | — | Grafana admin password |
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
| `MAX_PLUGIN_UPLOAD_BYTES` | `104857600` | Max plugin upload (100 MB) |

---

## AI Providers (Optional)

| Variable | Description |
|----------|-------------|
| `ANTHROPIC_API_KEY` | Anthropic API key |
| `OPENAI_API_KEY` | OpenAI API key |
| `GOOGLE_GENERATIVE_AI_API_KEY` | Google AI API key |
| `XAI_API_KEY` | xAI API key |
| `OLLAMA_BASE_URL` | Ollama URL (default: `http://ollama:11434`) |

At least one provider key is required for AI-powered pipeline and plugin generation. See the [AI plugins documentation](plugins/ai.md) for details on supported providers and models.
