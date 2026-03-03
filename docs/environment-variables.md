# Environment Variables Reference

All services are configured via environment variables. Copy `deploy/local/.env.example` (Docker Compose) or `deploy/minikube/.env.example` (Kubernetes) to `.env` and fill in secret values.

> **Security:** Never commit `.env` to version control. Generate JWT secrets with `openssl rand -base64 32`.

---

## Platform

| Variable | Default | Description |
|----------|---------|-------------|
| `PLATFORM_BASE_URL` | `https://localhost:8443` | API gateway URL used by services and CLI |
| `PLATFORM_FRONTEND_URL` | `https://localhost:8443` | Frontend URL for email links, OAuth redirects |
| `PORT` | `3000` | Service listen port (platform, quota, pipeline-core) |
| `TRUST_PROXY` | `1` | Trust proxy headers (set to `1` behind nginx/ALB) |

---

## Logging

| Variable | Default | Description |
|----------|---------|-------------|
| `LOG_LEVEL` | `info` | Log level: `error`, `warn`, `info`, `debug` |
| `LOG_FORMAT` | `json` | Log format: `json` (structured, for Loki) or `text` (human-readable) |
| `SERVICE_NAME` | `api` | Service name in log output |

---

## Grafana (Observability)

| Variable | Default | Description |
|----------|---------|-------------|
| `GRAFANA_ADMIN_USER` | `admin` | Grafana admin username (local dev only) |
| `GRAFANA_ADMIN_PASSWORD` | — | Grafana admin password |

---

## CORS

| Variable | Default | Description |
|----------|---------|-------------|
| `CORS_CREDENTIALS` | `true` | Allow credentials in CORS requests |
| `CORS_ORIGIN` | *(empty)* | Allowed origins (comma-separated). Empty = default |

---

## JWT Authentication (Required)

| Variable | Default | Description |
|----------|---------|-------------|
| `JWT_SECRET` | — | **Required.** Secret for signing/verifying JWTs |
| `JWT_EXPIRES_IN` | `86400` | Token expiration in seconds (86400 = 24h) |
| `JWT_ALGORITHM` | `HS256` | Signing algorithm: `HS256`, `HS384`, `HS512`, `RS256` |
| `JWT_SALT_ROUNDS` | `12` | bcrypt salt rounds (10–12 recommended) |
| `REFRESH_TOKEN_SECRET` | — | **Required.** Separate secret for refresh tokens |
| `REFRESH_TOKEN_EXPIRES_IN` | `2592000` | Refresh token expiration in seconds (2592000 = 30d) |

---

## Security

| Variable | Default | Description |
|----------|---------|-------------|
| `MIN_PASSWORD_LENGTH` | `12` | Minimum password length |
| `MAX_LOGIN_ATTEMPTS` | `5` | Max login attempts before account lockout |

---

## Google OAuth (Optional)

| Variable | Default | Description |
|----------|---------|-------------|
| `OAUTH_GOOGLE_CLIENT_ID` | — | Google OAuth Client ID (empty = disabled) |
| `OAUTH_GOOGLE_CLIENT_SECRET` | — | Google OAuth Client Secret |
| `OAUTH_CALLBACK_BASE_URL` | `${PLATFORM_FRONTEND_URL}` | OAuth redirect origin (override if frontend URL differs) |

---

## Quota Tier Defaults

Default quotas for organizations without an assigned tier. These match the **developer** tier.

| Variable | Default | Description |
|----------|---------|-------------|
| `QUOTA_DEFAULT_PLUGINS` | `100` | Max plugins per org |
| `QUOTA_DEFAULT_PIPELINES` | `10` | Max pipelines per org |
| `QUOTA_DEFAULT_API_CALLS` | `-1` | Max API calls per org (`-1` = unlimited) |
| `QUOTA_RESET_DAYS` | `3` | Quota reset period in days |

---

## Quota Service

| Variable | Default | Description |
|----------|---------|-------------|
| `QUOTA_SERVICE_HOST` | `quota` | Quota service hostname |
| `QUOTA_SERVICE_PORT` | `3000` | Quota service port |
| `QUOTA_BYPASS_ORG_ID` | `system` | Org ID that bypasses all quotas |

---

## Rate Limiting (Per-Operation)

| Variable | Default | Description |
|----------|---------|-------------|
| `QUOTA_DEFAULT_WINDOW_MS` | `60000` | Default rate limit window (60s) |
| `RATE_LIMIT_WINDOW_MS` | `60000` | Quota service rate limit window |
| `RATE_LIMIT_MAX` | `100` | Quota service max requests per window |
| `QUOTA_CREATE_PLUGIN_LIMIT` | `unlimited` | Create plugin: requests per window |
| `QUOTA_CREATE_PLUGIN_WINDOW_MS` | `60000` | Create plugin: window in ms |
| `QUOTA_GET_PLUGIN_LIMIT` | `10` | Get plugin: requests per window |
| `QUOTA_GET_PLUGIN_WINDOW_MS` | `60000` | Get plugin: window in ms |
| `QUOTA_CREATE_PIPELINE_LIMIT` | `unlimited` | Create pipeline: requests per window |
| `QUOTA_CREATE_PIPELINE_WINDOW_MS` | `60000` | Create pipeline: window in ms |
| `QUOTA_GET_PIPELINE_LIMIT` | `10` | Get pipeline: requests per window |
| `QUOTA_GET_PIPELINE_WINDOW_MS` | `60000` | Get pipeline: window in ms |

---

## Rate Limiting (Global)

Applied to all API requests, independent of quota middleware.

| Variable | Default | Description |
|----------|---------|-------------|
| `LIMITER_MAX` | `100` | Max requests per window |
| `LIMITER_WINDOWMS` | `900000` | Window in ms (900000 = 15 min) |

---

## Email

| Variable | Default | Description |
|----------|---------|-------------|
| `EMAIL_ENABLED` | `false` | Enable/disable email sending |
| `EMAIL_FROM` | `noreply@example.com` | Sender email address |
| `EMAIL_FROM_NAME` | `Platform` | Sender display name |
| `EMAIL_PROVIDER` | `smtp` | Provider: `smtp` or `ses` |

### SMTP

| Variable | Default | Description |
|----------|---------|-------------|
| `SMTP_HOST` | `localhost` | SMTP server host |
| `SMTP_PORT` | `587` | SMTP server port |
| `SMTP_SECURE` | `false` | Use TLS |
| `SMTP_USER` | — | SMTP username |
| `SMTP_PASS` | — | SMTP password |

### AWS SES

| Variable | Default | Description |
|----------|---------|-------------|
| `SES_REGION` | `us-east-1` | SES region |
| `SES_ACCESS_KEY_ID` | — | AWS access key for SES |
| `SES_SECRET_ACCESS_KEY` | — | AWS secret key for SES |
| `AWS_REGION` | `us-east-1` | AWS region |

---

## Invitations

| Variable | Default | Description |
|----------|---------|-------------|
| `INVITATION_EXPIRATION_DAYS` | `7` | Invitation link expiration in days |
| `INVITATION_MAX_PENDING_PER_ORG` | `50` | Max pending invitations per org |

---

## PostgreSQL

| Variable | Default | Description |
|----------|---------|-------------|
| `POSTGRES_USER` | `postgres` | PostgreSQL superuser (container init) |
| `POSTGRES_PASSWORD` | — | PostgreSQL superuser password |
| `POSTGRES_DB` | `pipeline_builder` | Database name (container init) |
| `DB_HOST` | `postgres` | Database host for services |
| `DB_PORT` | `5432` | Database port |
| `DATABASE` | `pipeline_builder` | Database name for services |
| `DB_USER` | `postgres` | Database user for services |
| `DB_PASSWORD` | — | Database password for services |
| `DRIZZLE_MAX_POOL_SIZE` | `20` | Drizzle ORM connection pool size |
| `DRIZZLE_IDLE_TIMEOUT_MILLIS` | `30000` | Idle connection timeout (ms) |
| `DRIZZLE_CONNECTION_TIMEOUT_MILLIS` | `10000` | Connection timeout (ms) |

---

## MongoDB

| Variable | Default | Description |
|----------|---------|-------------|
| `MONGO_INITDB_ROOT_USERNAME` | `mongo` | MongoDB root username |
| `MONGO_INITDB_ROOT_PASSWORD` | — | MongoDB root password |
| `MONGO_INITDB_DATABASE` | `platform` | Initial database |
| `MONGODB_URI` | — | Full connection URI with replica set |

---

## Mongo Express (Admin UI)

| Variable | Default | Description |
|----------|---------|-------------|
| `ME_CONFIG_SITE_BASEURL` | `/mongo-express/` | URL base path |
| `ME_CONFIG_MONGODB_URL` | — | MongoDB connection URI |
| `ME_CONFIG_MONGODB_ENABLE_ADMIN` | `true` | Enable admin features |
| `ME_CONFIG_MONGODB_ADMINUSERNAME` | `mongo` | MongoDB admin username |
| `ME_CONFIG_MONGODB_ADMINPASSWORD` | — | MongoDB admin password |
| `ME_CONFIG_BASICAUTH_USERNAME` | `admin` | Web UI username |
| `ME_CONFIG_BASICAUTH_PASSWORD` | — | Web UI password |

---

## PgAdmin (Admin UI)

| Variable | Default | Description |
|----------|---------|-------------|
| `PGADMIN_DEFAULT_EMAIL` | `admin@localhost` | PgAdmin login email |
| `PGADMIN_DEFAULT_PASSWORD` | — | PgAdmin login password |

---

## Docker Registry

| Variable | Default | Description |
|----------|---------|-------------|
| `IMAGE_REGISTRY_HOST` | `registry` | Registry hostname |
| `IMAGE_REGISTRY_PORT` | `5000` | Registry port |
| `IMAGE_REGISTRY_USER` | `admin` | Registry username |
| `IMAGE_REGISTRY_TOKEN` | — | Registry password/token |
| `DOCKER_GID` | `0` | Docker socket GID on host |
| `DOCKER_NETWORK` | `backend-network` | Docker network for plugin builds |

---

## Redis & Job Queue

Used by the plugin service for BullMQ Docker build queue.

| Variable | Default | Description |
|----------|---------|-------------|
| `REDIS_HOST` | `redis` | Redis hostname |
| `REDIS_PORT` | `6379` | Redis port |
| `PLUGIN_BUILD_CONCURRENCY` | `1` | Max concurrent Docker plugin builds (BullMQ worker concurrency). In minikube, derived from plugin Deployment replicas via kustomize. |

> **Important:** Redis must use `maxmemory-policy noeviction` for BullMQ. The `allkeys-lru` policy causes silent job data loss.

---

## Registry UI

| Variable | Default | Description |
|----------|---------|-------------|
| `JOXIT_REGISTRY_TITLE` | `Pipeline Builder Registry` | Registry UI title |
| `JOXIT_NGINX_PROXY_PASS_URL` | `https://registry:5000` | Registry backend URL |
| `JOXIT_SINGLE_REGISTRY` | `true` | Single registry mode |
| `JOXIT_ENABLE_DELETE_IMAGES` | `true` | Allow image deletion from UI |
| `JOXIT_SHOW_CONTENT_DIGEST` | `true` | Show content digests |

---

## Loki (Log Aggregation)

| Variable | Default | Description |
|----------|---------|-------------|
| `LOKI_URL` | `http://loki:3100` | Loki URL for log queries |

---

## Billing

| Variable | Default | Description |
|----------|---------|-------------|
| `BILLING_ENABLED` | `false` | Enable/disable billing service |
| `BILLING_SERVICE_HOST` | `billing` | Billing service hostname |
| `BILLING_SERVICE_PORT` | `3000` | Billing service port |
| `BILLING_PROVIDER` | `stub` | Provider: `stub` (local dev) or `aws-marketplace` |

### Billing Plan Pricing (in cents)

Plan definitions are centralized in `pipeline-core/src/config/billing-config.ts` and seeded into MongoDB on startup. Prices are the most likely values to change per environment.

| Variable | Default | Description |
|----------|---------|-------------|
| `BILLING_PLAN_DEVELOPER_MONTHLY` | `0` | Developer plan monthly price (cents) |
| `BILLING_PLAN_DEVELOPER_ANNUAL` | `0` | Developer plan annual price (cents) |
| `BILLING_PLAN_PRO_MONTHLY` | `799` | Pro plan monthly price (cents) |
| `BILLING_PLAN_PRO_ANNUAL` | `7990` | Pro plan annual price (cents) |
| `BILLING_PLAN_UNLIMITED_MONTHLY` | `1199` | Unlimited plan monthly price (cents) |
| `BILLING_PLAN_UNLIMITED_ANNUAL` | `11990` | Unlimited plan annual price (cents) |

### Billing Plan Overrides (Optional)

| Variable | Default | Description |
|----------|---------|-------------|
| `BILLING_PLAN_DEVELOPER_DESCRIPTION` | *(code default)* | Developer plan description |
| `BILLING_PLAN_PRO_DESCRIPTION` | *(code default)* | Pro plan description |
| `BILLING_PLAN_UNLIMITED_DESCRIPTION` | *(code default)* | Unlimited plan description |
| `BILLING_PLAN_DEVELOPER_FEATURES` | *(code default)* | Developer features (JSON array) |
| `BILLING_PLAN_PRO_FEATURES` | *(code default)* | Pro features (JSON array) |
| `BILLING_PLAN_UNLIMITED_FEATURES` | *(code default)* | Unlimited features (JSON array) |

### AWS Marketplace (when `BILLING_PROVIDER=aws-marketplace`)

| Variable | Default | Description |
|----------|---------|-------------|
| `AWS_MARKETPLACE_PRODUCT_CODE` | — | Marketplace product code |
| `AWS_MARKETPLACE_REGION` | `us-east-1` | Marketplace region |
| `AWS_MARKETPLACE_SNS_TOPIC_ARN` | — | SNS topic ARN for notifications |
| `AWS_MARKETPLACE_DIMENSION_MAP` | — | Usage dimension mapping |

---

## Internal Service URLs

Used by the platform service to route to microservices.

| Variable | Default | Description |
|----------|---------|-------------|
| `LIST_PLUGINS_URL` | `https://localhost:8443` | Plugin list endpoint base |
| `GET_PLUGIN_URL` | `https://localhost:8443` | Plugin get endpoint base |
| `UPLOAD_PLUGIN_URL` | `https://localhost:8443` | Plugin upload endpoint base |
| `LIST_PIPELINES_URL` | `https://localhost:8443` | Pipeline list endpoint base |
| `GET_PIPELINE_URL` | `https://localhost:8443` | Pipeline get endpoint base |
| `CREATE_PIPELINE_URL` | `https://localhost:8443` | Pipeline create endpoint base |
| `SERVICE_TIMEOUT` | `30000` | Internal service HTTP timeout (ms) |
| `HANDLER_TIMEOUT_MS` | `30000` | Pipeline-core handler timeout (ms) |

---

## Message Routing

Email-like aliases that are automatically resolved to the system organization when creating messages.

| Variable | Default | Description |
|----------|---------|-------------|
| `SUPPORT_ALIASES` | *(empty)* | Comma-separated list of email aliases that resolve to the system org (e.g. `support@pipeline-builder,help@pipeline-builder`) |

---

## AWS CDK / Lambda

Used by pipeline-core for CDK infrastructure builds.

| Variable | Default | Description |
|----------|---------|-------------|
| `LAMBDA_RUNTIME` | `nodejs24.x` | Lambda runtime version |
| `LAMBDA_TIMEOUT` | `900` | Lambda timeout in seconds (max 900) |
| `LAMBDA_MEMORY_SIZE` | `128` | Lambda memory in MB |
| `LAMBDA_ARCHITECTURE` | `ARM_64` | Architecture: `ARM_64` or `x86_64` |

---

## AWS CloudWatch / CodeBuild

| Variable | Default | Description |
|----------|---------|-------------|
| `LOG_GROUP_NAME` | `/pipeline-builder/logs` | CloudWatch log group name |
| `LOG_RETENTION` | `1` | Log retention in days (1, 3, 5, 7, 14, 30, 60, 90, etc.) |
| `LOG_REMOVAL_POLICY` | `DESTROY` | Log removal policy: `DESTROY` or `RETAIN` |
| `CODEBUILD_COMPUTE_TYPE` | `SMALL` | CodeBuild compute: `SMALL`, `MEDIUM`, `LARGE`, `X2_LARGE` |

---

## HTTP Client

Used by api-core's internal HTTP client for service-to-service communication.

| Variable | Default | Description |
|----------|---------|-------------|
| `HTTP_CLIENT_TIMEOUT` | `5000` | HTTP client timeout in ms |
| `HTTP_CLIENT_MAX_RETRIES` | `2` | Max retry attempts for failed requests |
| `HTTP_CLIENT_RETRY_DELAY_MS` | `200` | Delay between retries in ms |

---

## SSE (Server-Sent Events)

Used by api-server's SSE connection manager for real-time streaming.

| Variable | Default | Description |
|----------|---------|-------------|
| `SSE_MAX_CLIENTS_PER_REQUEST` | `10` | Max SSE clients per request |
| `SSE_CLIENT_TIMEOUT_MS` | `1800000` | SSE client timeout in ms (1800000 = 30 min) |
| `SSE_CLEANUP_INTERVAL_MS` | `300000` | SSE cleanup interval in ms (300000 = 5 min) |

---

## Plugin Build Queue

Used by the plugin service's BullMQ job queue for Docker builds.

| Variable | Default | Description |
|----------|---------|-------------|
| `PLUGIN_BUILD_QUEUE_NAME` | `plugin-build` | BullMQ queue name for plugin builds |
| `PLUGIN_BUILD_MAX_ATTEMPTS` | `2` | Max build attempts before failing |
| `PLUGIN_BUILD_BACKOFF_DELAY_MS` | `5000` | Exponential backoff delay in ms |
| `PLUGIN_BUILD_COMPLETED_RETENTION_SECS` | `3600` | Completed job retention (3600 = 1h) |
| `PLUGIN_BUILD_FAILED_RETENTION_SECS` | `86400` | Failed job retention (86400 = 24h) |
| `PLUGIN_BUILD_WORKER_TIMEOUT_MS` | `10000` | Worker ready timeout in ms |

---

## Docker Build

Used by the plugin service for building plugin Docker images.

| Variable | Default | Description |
|----------|---------|-------------|
| `DOCKER_BUILD_TIMEOUT_MS` | `300000` | Docker build timeout in ms (300000 = 5 min) |
| `DOCKER_BUILDER_NAME` | `plugin-builder` | Docker buildx builder name |
| `PLUGIN_IMAGE_PREFIX` | `p-` | Plugin image tag prefix |

---

## Pagination & Limits

Used across api-core validation, pipeline-core, and platform controllers.

| Variable | Default | Description |
|----------|---------|-------------|
| `MAX_PAGE_LIMIT` | `1000` | Max page limit for paginated queries |
| `DEFAULT_PAGE_LIMIT` | `100` | Default page limit when not specified |
| `MAX_PROMPT_LENGTH` | `5000` | Max AI prompt length in characters |
| `MAX_PLUGIN_UPLOAD_BYTES` | `104857600` | Max plugin upload size in bytes (100 MB) |
| `PIPELINE_NAME_MAX_LENGTH` | `100` | Max pipeline name length |
| `DEFAULT_PLUGIN_VERSION` | `1.0.0` | Default plugin version when not specified |

---

## Database Connection Retries

Used by pipeline-data's PostgreSQL connection manager.

| Variable | Default | Description |
|----------|---------|-------------|
| `DB_MAX_RETRIES` | `3` | Max connection retry attempts |
| `DB_RETRY_DELAY_MS` | `1000` | Delay between retries in ms |

---

## Cookie

Used by platform authentication controllers.

| Variable | Default | Description |
|----------|---------|-------------|
| `COOKIE_SAME_SITE` | `lax` | SameSite cookie attribute: `lax`, `strict`, or `none` |

---

## Google OAuth URL Overrides

Override default Google OAuth endpoints. Useful for custom OAuth providers.

| Variable | Default | Description |
|----------|---------|-------------|
| `GOOGLE_AUTHORIZE_URL` | `https://accounts.google.com/o/oauth2/v2/auth` | Google OAuth authorize URL |
| `GOOGLE_TOKEN_URL` | `https://oauth2.googleapis.com/token` | Google OAuth token URL |
| `GOOGLE_USERINFO_URL` | `https://www.googleapis.com/oauth2/v2/userinfo` | Google userinfo URL |
| `OAUTH_CLEANUP_INTERVAL_MS` | `60000` | OAuth CSRF state cleanup interval in ms |

---

## Platform Log & Pagination

Used by platform log service and list controllers.

| Variable | Default | Description |
|----------|---------|-------------|
| `LOG_DEFAULT_LIMIT` | `100` | Default log query limit |
| `LOG_MAX_LIMIT` | `1000` | Max log query limit |
| `LOG_DEFAULT_LOOKBACK_MS` | `3600000` | Default log lookback window in ms (1 hour) |
| `PLATFORM_LIST_MAX` | `100` | Platform list endpoints max items |
| `PLATFORM_LIST_DEFAULT` | `20` | Platform list endpoints default items |

---

## Additional (Optional)

These variables are not set by default. Uncomment in `.env` as needed.

| Variable | Description |
|----------|-------------|
| `PLUGIN_MAX_UPLOAD_MB` | Max plugin ZIP upload size in MB |
| `DOCKER_REGISTRY_INSECURE` | Allow insecure registry connections |
| `ANTHROPIC_API_KEY` | Anthropic API key (AI generation) |
| `OPENAI_API_KEY` | OpenAI API key (AI generation) |
| `GOOGLE_GENERATIVE_AI_API_KEY` | Google AI API key (AI generation) |
| `XAI_API_KEY` | xAI API key (AI generation) |
| `AUTH_LIMITER_MAX` | Auth endpoint rate limit max |
| `AUTH_LIMITER_WINDOWMS` | Auth endpoint rate limit window (ms) |
| `BILLING_SERVICE_TIMEOUT` | Billing service HTTP timeout (ms) |
| `QUOTA_SERVICE_TIMEOUT` | Quota service HTTP timeout (ms) |
