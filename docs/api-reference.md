# API Reference

REST API for managing pipelines, plugins, and reporting. All services run behind an Nginx gateway that handles TLS termination and JWT validation.

**Related docs:** [Environment Variables](environment-variables.md) | [Plugin Catalog](plugins/README.md) | [AWS Deployment](aws-deployment.md)

---

## Authentication

All requests require two headers:

| Header | Description |
|--------|-------------|
| `Authorization` | `Bearer <JWT>` -- obtained from the platform login endpoint |
| `x-org-id` | Organization ID -- scopes the request to a specific tenant |

Tokens expire after 24 hours by default (configurable via `JWT_EXPIRES_IN`). Use the refresh token endpoint to obtain a new access token without re-authenticating.

---

## Endpoints

### Pipeline Service

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/pipelines` | List pipelines (filterable, paginated) |
| `GET` | `/pipelines/find` | Find one pipeline by query |
| `GET` | `/pipelines/:id` | Get by ID |
| `POST` | `/pipelines` | Create pipeline |
| `PUT` | `/pipelines/:id` | Update pipeline |
| `DELETE` | `/pipelines/:id` | Delete pipeline |
| `GET` | `/pipelines/providers` | List AI providers |
| `POST` | `/pipelines/generate` | AI-generate pipeline from prompt (consumes `aiCalls` quota) |
| `POST` | `/pipelines/generate/stream` | Stream AI generation as SSE (consumes `aiCalls` quota) |
| `POST` | `/pipelines/generate/from-url/stream` | Analyze Git URL + stream pipeline (consumes `aiCalls` quota) |
| `GET` | `/pipelines/registry` | List ARN→pipelineId mappings for the caller's org |
| `POST` | `/pipelines/registry` | Upsert registry entry (deploy hook; tenant-guarded) |

### Plugin Service

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/plugins` | List plugins (filterable, paginated) |
| `GET` | `/plugins/find` | Find one plugin by query |
| `GET` | `/plugins/:id` | Get by ID |
| `POST` | `/plugins` | Upload plugin (ZIP multipart) |
| `POST` | `/plugins/lookup` | Find plugin by validated filter body (POST for URL-length safety) |
| `PUT` | `/plugins/:id` | Update plugin |
| `PUT` | `/plugins/bulk/update` | Bulk-update plugins (strict whitelist of mutable fields) |
| `DELETE` | `/plugins/:id` | Delete plugin |
| `GET` | `/plugins/providers` | List AI providers |
| `POST` | `/plugins/generate` | AI-generate plugin from prompt (consumes `aiCalls` quota) |
| `POST` | `/plugins/generate/stream` | Stream AI plugin generation as SSE (consumes `aiCalls` quota) |
| `POST` | `/plugins/deploy-generated` | Build and deploy AI-generated plugin |
| `GET` | `/plugins/plugin-usage` | Counts pipelines (in caller's org) referencing each plugin name |
| `GET` | `/plugins/queue/status` | Build queue counts (admin only) |
| `GET` | `/plugins/queue/failed` | Failed build jobs (org-scoped for non-system admins) |
| `GET` | `/plugins/queue/dlq` | Dead letter queue jobs (org-scoped for non-system admins) |
| `POST` | `/plugins/queue/dlq/:jobId/replay` | Replay a single DLQ job (admin only, tenant-checked) |
| `DELETE` | `/plugins/queue/dlq` | Purge all DLQ jobs (system admin only) |

### Compliance Service

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/compliance/scans` | Trigger a scan (caller-supplied `filter.orgId` is server-overwritten) |
| `POST` | `/compliance/exemptions` | Request an exemption |
| `POST` | `/compliance/exemptions/bulk` | Bulk-create up to 500 exemptions in one call |
| `PUT` | `/compliance/exemptions/:id/review` | Approve/reject an exemption (requester cannot self-approve) |
| `POST` | `/compliance/scan-schedules` | Create a cron-driven scan schedule (cron validated at insert time) |
| `POST` | `/compliance/validate/{plugin\|pipeline}` | Live compliance check (5s timeout, fail-closed) |
| `POST` | `/compliance/validate/{plugin\|pipeline}/dry-run` | Same evaluation, no audit/notify side-effects |

### Quota Service

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/quotas` | Caller's org quotas (plugins/pipelines/apiCalls/aiCalls) |
| `GET` | `/quotas/all` | All orgs' quotas (system admin only) |
| `GET` | `/quotas/at-risk?threshold=80` | Orgs ≥ threshold% on any quota dimension (system admin only) |
| `GET` | `/quotas/:orgId` | Specific org quotas (orgId in URL — auth scoped) |
| `GET` | `/quotas/:orgId/:type` | Single quota type status |
| `PUT` | `/quotas/:orgId` | Update tier/limits (system admin only) |
| `POST` | `/quotas/:orgId/reset` | Reset usage counters (system admin only) |
| `POST` | `/quotas/:orgId/increment` | Internal: increment usage (service-to-service, `amount` capped at 1000/call) |

### Common Query Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `limit` | int | `10` | Page size (1-100) |
| `offset` | int | `0` | Records to skip |
| `sortBy` | string | `createdAt` | Sort field |
| `sortOrder` | `asc`/`desc` | `desc` | Sort direction |
| `accessModifier` | `public`/`private` | — | Filter by visibility |
| `isActive` | boolean | — | Filter by active status |
| `isDefault` | boolean | — | Filter by default status |

---

## Examples

### Plugins

**Upload:**

```bash
curl -X POST https://localhost:8443/api/plugins \
  -H "Authorization: Bearer $TOKEN" \
  -H "x-org-id: $ORG_ID" \
  -F "plugin=@./my-plugin.zip" \
  -F "accessModifier=private"
```

**List / Find:**

```bash
curl "https://localhost:8443/api/plugins?name=node-build&limit=10" \
  -H "Authorization: Bearer $TOKEN" -H "x-org-id: $ORG_ID"

curl "https://localhost:8443/api/plugins/find?name=node-build&version=1.0.0" \
  -H "Authorization: Bearer $TOKEN" -H "x-org-id: $ORG_ID"
```

**Update:**

```bash
curl -X PUT "https://localhost:8443/api/plugins/<id>" \
  -H "Authorization: Bearer $TOKEN" -H "x-org-id: $ORG_ID" \
  -H "Content-Type: application/json" \
  -d '{"description": "Updated plugin", "computeType": "LARGE", "isDefault": true}'
```

**Delete:**

```bash
curl -X DELETE "https://localhost:8443/api/plugins/<id>" \
  -H "Authorization: Bearer $TOKEN" -H "x-org-id: $ORG_ID"
```

### Pipelines

**Create:**

```bash
curl -X POST https://localhost:8443/api/pipelines \
  -H "Authorization: Bearer $TOKEN" -H "x-org-id: $ORG_ID" \
  -H "Content-Type: application/json" \
  -d '{
    "project": "my-app",
    "organization": "my-org",
    "pipelineName": "my-app-pipeline",
    "accessModifier": "private",
    "props": {
      "project": "my-app",
      "organization": "my-org",
      "synth": {
        "source": {
          "type": "github",
          "options": { "repo": "my-org/my-app", "branch": "main" }
        },
        "plugin": { "name": "cdk-synth", "version": "1.0.0" }
      }
    }
  }'
```

**List / Find:**

```bash
curl "https://localhost:8443/api/pipelines?project=my-app&limit=10" \
  -H "Authorization: Bearer $TOKEN" -H "x-org-id: $ORG_ID"

curl "https://localhost:8443/api/pipelines/find?project=my-app&organization=my-org" \
  -H "Authorization: Bearer $TOKEN" -H "x-org-id: $ORG_ID"
```

### AI Generation

**Generate pipeline:**

```bash
curl -X POST https://localhost:8443/api/pipelines/generate \
  -H "Authorization: Bearer $TOKEN" -H "x-org-id: $ORG_ID" \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "Build a Node.js app from GitHub, run tests, and deploy with CDK",
    "provider": "anthropic",
    "model": "claude-sonnet-4-20250514"
  }'
```

**Generate + deploy plugin:**

```bash
# Step 1: Generate
curl -X POST https://localhost:8443/api/plugins/generate \
  -H "Authorization: Bearer $TOKEN" -H "x-org-id: $ORG_ID" \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "A Node.js 20 build plugin that runs npm ci, npm test, and npm run build",
    "provider": "anthropic",
    "model": "claude-sonnet-4-20250514"
  }'

# Step 2: Deploy (review/edit the generated output, then submit)
curl -X POST https://localhost:8443/api/plugins/deploy-generated \
  -H "Authorization: Bearer $TOKEN" -H "x-org-id: $ORG_ID" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "nodejs-build",
    "version": "1.0.0",
    "commands": ["npm run build"],
    "installCommands": ["npm ci"],
    "dockerfile": "FROM node:20-slim\n..."
  }'
```

---

## Response Format

All API responses follow a consistent format:

**Success:**
```json
{
  "success": true,
  "data": { ... }
}
```

**Paginated:**
```json
{
  "success": true,
  "data": [ ... ],
  "pagination": {
    "total": 42,
    "limit": 10,
    "offset": 0,
    "hasMore": true
  }
}
```

**Error:**
```json
{
  "success": false,
  "error": {
    "code": "NOT_FOUND",
    "message": "Pipeline not found"
  }
}
```

---

## Reporting Endpoints

Pipeline execution and plugin build analytics. Time ranges default to the last 30 days. See [AWS Deployment -- Report API Endpoints](aws-deployment.md#report-api-endpoints) for the full endpoint list with query parameters.

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/reports/execution/count` | Execution count per pipeline with status breakdown |
| `GET` | `/reports/execution/success-rate` | Pass/fail rate over time |
| `GET` | `/reports/execution/duration` | Avg/min/max/p95 execution duration |
| `GET` | `/reports/execution/stage-failures` | Stage failure heatmap |
| `GET` | `/reports/execution/stage-bottlenecks` | Slowest stages per pipeline |
| `GET` | `/reports/execution/errors` | Error categorization (top N) |
| `GET` | `/reports/plugins/summary` | Plugin inventory stats |
| `GET` | `/reports/plugins/build-success-rate` | Docker build success rate over time |
| `GET` | `/reports/plugins/build-duration` | Build time per plugin |
| `GET` | `/reports/plugins/build-failures` | Build failure reasons (top N) |
