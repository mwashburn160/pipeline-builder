# API Reference

All requests require `Authorization: Bearer <JWT>` and `x-org-id: <org-id>` headers.

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
| `POST` | `/pipelines/generate` | AI-generate pipeline from prompt |

### Plugin Service

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/plugins` | List plugins (filterable, paginated) |
| `GET` | `/plugins/find` | Find one plugin by query |
| `GET` | `/plugins/:id` | Get by ID |
| `POST` | `/plugins` | Upload plugin (ZIP multipart) |
| `PUT` | `/plugins/:id` | Update plugin |
| `DELETE` | `/plugins/:id` | Delete plugin |
| `GET` | `/plugins/providers` | List AI providers |
| `POST` | `/plugins/generate` | AI-generate plugin from prompt |
| `POST` | `/plugins/deploy-generated` | Build and deploy AI-generated plugin |

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
