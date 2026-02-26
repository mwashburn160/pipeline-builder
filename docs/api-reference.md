# API Reference

All API requests require:
- `Authorization: Bearer <JWT>` — JWT token from the Platform service
- `x-org-id: <org-id>` — Organization ID header

---

## Pipeline Service

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/pipelines` | List pipelines with filtering, pagination, sorting |
| `GET` | `/pipelines/find` | Find a single pipeline by query parameters |
| `GET` | `/pipelines/:id` | Get pipeline by ID |
| `POST` | `/pipelines` | Create a new pipeline |
| `PUT` | `/pipelines/:id` | Update an existing pipeline |
| `DELETE` | `/pipelines/:id` | Delete a pipeline |
| `GET` | `/pipelines/providers` | List configured AI providers |
| `POST` | `/pipelines/generate` | AI-generate pipeline configuration from a prompt |

## Plugin Service

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/plugins` | List plugins with filtering, pagination, sorting |
| `GET` | `/plugins/find` | Find a single plugin by query parameters |
| `GET` | `/plugins/:id` | Get plugin by ID |
| `POST` | `/plugins` | Upload a plugin (ZIP multipart) |
| `PUT` | `/plugins/:id` | Update an existing plugin |
| `DELETE` | `/plugins/:id` | Delete a plugin |
| `GET` | `/plugins/providers` | List configured AI providers |
| `POST` | `/plugins/generate` | AI-generate plugin config + Dockerfile from a prompt |
| `POST` | `/plugins/deploy-generated` | Build and deploy an AI-generated plugin |

## Common Query Parameters (List Endpoints)

| Parameter | Type | Description |
|-----------|------|-------------|
| `limit` | integer | Page size (1-100, default: 10) |
| `offset` | integer | Records to skip (default: 0) |
| `sortBy` | string | Field to sort by (default: `createdAt`) |
| `sortOrder` | `asc` / `desc` | Sort direction (default: `desc`) |
| `accessModifier` | `public` / `private` | Filter by visibility |
| `isActive` | boolean | Filter by active status |
| `isDefault` | boolean | Filter by default status |

---

## Plugin CRUD Examples

### Create (Upload ZIP)

```bash
curl -X POST https://localhost:8443/api/plugins \
  -H "Authorization: Bearer $TOKEN" \
  -H "x-org-id: $ORG_ID" \
  -F "plugin=@./my-plugin.zip" \
  -F "accessModifier=private"
```

### List

```bash
# List with filtering and pagination
curl "https://localhost:8443/api/plugins?name=node-build&limit=10&sortBy=createdAt&sortOrder=desc" \
  -H "Authorization: Bearer $TOKEN" \
  -H "x-org-id: $ORG_ID"

# Find by name and version
curl "https://localhost:8443/api/plugins/find?name=node-build&version=1.0.0" \
  -H "Authorization: Bearer $TOKEN" \
  -H "x-org-id: $ORG_ID"
```

### Get by ID

```bash
curl "https://localhost:8443/api/plugins/<plugin-id>" \
  -H "Authorization: Bearer $TOKEN" \
  -H "x-org-id: $ORG_ID"
```

### Update

```bash
curl -X PUT "https://localhost:8443/api/plugins/<plugin-id>" \
  -H "Authorization: Bearer $TOKEN" \
  -H "x-org-id: $ORG_ID" \
  -H "Content-Type: application/json" \
  -d '{
    "description": "Updated Node.js build with caching",
    "commands": ["npm ci --cache .npm", "npm run build"],
    "computeType": "LARGE",
    "isDefault": true
  }'
```

### Delete

```bash
curl -X DELETE "https://localhost:8443/api/plugins/<plugin-id>" \
  -H "Authorization: Bearer $TOKEN" \
  -H "x-org-id: $ORG_ID"
```

---

## Pipeline CRUD Examples

### Create

```bash
curl -X POST https://localhost:8443/api/pipelines \
  -H "Authorization: Bearer $TOKEN" \
  -H "x-org-id: $ORG_ID" \
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

### List

```bash
# List with filtering and pagination
curl "https://localhost:8443/api/pipelines?project=my-app&limit=10&sortBy=createdAt&sortOrder=desc" \
  -H "Authorization: Bearer $TOKEN" \
  -H "x-org-id: $ORG_ID"

# Find by project and organization
curl "https://localhost:8443/api/pipelines/find?project=my-app&organization=my-org" \
  -H "Authorization: Bearer $TOKEN" \
  -H "x-org-id: $ORG_ID"
```

### Get by ID

```bash
curl "https://localhost:8443/api/pipelines/<pipeline-id>" \
  -H "Authorization: Bearer $TOKEN" \
  -H "x-org-id: $ORG_ID"
```

### Update

```bash
curl -X PUT "https://localhost:8443/api/pipelines/<pipeline-id>" \
  -H "Authorization: Bearer $TOKEN" \
  -H "x-org-id: $ORG_ID" \
  -H "Content-Type: application/json" \
  -d '{
    "pipelineName": "my-app-pipeline-v2",
    "description": "Updated with deploy stage",
    "props": {
      "project": "my-app",
      "organization": "my-org",
      "synth": {
        "source": { "type": "github", "options": { "repo": "my-org/my-app", "branch": "main" } },
        "plugin": { "name": "cdk-synth", "version": "2.0.0" }
      },
      "stages": [
        { "stageName": "Test", "steps": [{ "name": "tests", "plugin": { "name": "jest-test", "version": "1.0.0" } }] },
        { "stageName": "Deploy", "steps": [{ "name": "deploy", "plugin": { "name": "cdk-deploy", "version": "1.0.0" } }] }
      ]
    }
  }'
```

### Delete

```bash
curl -X DELETE "https://localhost:8443/api/pipelines/<pipeline-id>" \
  -H "Authorization: Bearer $TOKEN" \
  -H "x-org-id: $ORG_ID"
```

---

## AI Generation Examples

### Generate a Pipeline

```bash
# Step 1: Generate configuration from a prompt
curl -X POST https://localhost:8443/api/pipelines/generate \
  -H "Authorization: Bearer $TOKEN" \
  -H "x-org-id: $ORG_ID" \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "Build a Node.js app from GitHub, run tests, and deploy with CDK",
    "provider": "anthropic",
    "model": "claude-sonnet-4-20250514"
  }'

# Step 2: Review the generated props, then create the pipeline
curl -X POST https://localhost:8443/api/pipelines \
  -H "Authorization: Bearer $TOKEN" \
  -H "x-org-id: $ORG_ID" \
  -H "Content-Type: application/json" \
  -d '{ "project": "my-app", "organization": "my-org", "props": <generated-props> }'
```

### Generate a Plugin (Two-Step)

```bash
# Step 1: Generate plugin config + Dockerfile from a prompt
curl -X POST https://localhost:8443/api/plugins/generate \
  -H "Authorization: Bearer $TOKEN" \
  -H "x-org-id: $ORG_ID" \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "A Node.js 20 build plugin that runs npm ci, npm test, and npm run build",
    "provider": "anthropic",
    "model": "claude-sonnet-4-20250514"
  }'

# Step 2: Review, edit if needed, then deploy the generated plugin
curl -X POST https://localhost:8443/api/plugins/deploy-generated \
  -H "Authorization: Bearer $TOKEN" \
  -H "x-org-id: $ORG_ID" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "nodejs-build",
    "version": "1.0.0",
    "commands": ["npm run build"],
    "installCommands": ["npm ci"],
    "dockerfile": "FROM node:20-slim\n..."
  }'
```
