# Secrets Management Pipeline (TypeScript)

## Overview

Demonstrates how secrets are injected into pipeline steps at two levels: globally via `orgId` for tenant-scoped secret resolution, and per-step through plugin `secrets` declarations. Secrets are stored in AWS Secrets Manager and automatically injected as `SECRETS_MANAGER`-type CodeBuild environment variables.

## What This Example Shows

### Global: Tenant-Scoped Secrets (`BuilderProps.orgId`)

Setting `orgId` on `BuilderProps` enables automatic secret resolution for **all plugins** that declare `secrets` in their plugin database record. This is the global mechanism — one configuration unlocks secrets for every step.

```typescript
const pipelineProps: BuilderProps = {
  orgId: 'acmecorp-tenant-001',  // Enables secret resolution for all plugins
  // ...
};
```

**Secret path convention:**
```
pipeline-builder/{orgId}/{secretName}
```

For example, with `orgId: 'acmecorp-tenant-001'` and a plugin declaring `secrets: [{ name: 'API_KEY', required: true }]`, the secret is resolved from:
```
pipeline-builder/acmecorp-tenant-001/API_KEY
```

### Step-Level: Plugin Secret Declarations

Each plugin declares its secret requirements in its database record:

```typescript
// Plugin database record (created via API, not in pipeline config)
{
  name: 'snyk',
  secrets: [
    { name: 'SNYK_TOKEN', required: true, description: 'Snyk API authentication token' }
  ]
}
```

When a pipeline step uses this plugin and `orgId` is set, the secret is **automatically** injected — no manual wiring needed. The step's commands can reference `$SNYK_TOKEN` directly.

## Secret Resolution Flow

```
BuilderProps.orgId = 'acmecorp-tenant-001'
         │
         ▼
┌─────────────────────────────────────────────────────┐
│  Plugin: snyk                                       │
│  secrets: [{ name: 'SNYK_TOKEN', required: true }]  │
│                                                     │
│  Resolves to CodeBuild env var:                     │
│    SNYK_TOKEN = SECRETS_MANAGER type                │
│    Value path: pipeline-builder/acmecorp-tenant-001 │
│                /SNYK_TOKEN                          │
└─────────────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────────┐
│  AWS Secrets Manager                                │
│  ┌───────────────────────────────────────────────┐  │
│  │  pipeline-builder/acmecorp-tenant-001/        │  │
│  │  ├── NPM_TOKEN                                │  │
│  │  ├── SNYK_TOKEN                               │  │
│  │  ├── DOCKER_USERNAME                          │  │
│  │  ├── DOCKER_PASSWORD                          │  │
│  │  ├── AWS_DEPLOY_ROLE_ARN                      │  │
│  │  ├── DATADOG_API_KEY                          │  │
│  │  └── SLACK_WEBHOOK_URL                        │  │
│  └───────────────────────────────────────────────┘  │
│                                                     │
│  pipeline-builder/other-tenant-002/                 │
│  ├── NPM_TOKEN          ← Different tenant,        │
│  ├── SNYK_TOKEN            different secrets        │
│  └── ...                                            │
└─────────────────────────────────────────────────────┘
```

## Secrets Used Per Stage

| Stage | Plugin | Secrets | Required |
|-------|--------|---------|----------|
| **Build-Test** | nodejs-build | `NPM_TOKEN` | Yes |
| **Security** | snyk | `SNYK_TOKEN` | Yes |
| **Container** | docker-build | `DOCKER_USERNAME`, `DOCKER_PASSWORD` | Yes |
| **Deploy** | cdk-deploy | `AWS_DEPLOY_ROLE_ARN`, `DATADOG_API_KEY` | Yes / No |
| **Notify** | slack-notify | `SLACK_WEBHOOK_URL` | Yes |

## Required vs Optional Secrets

- **Required secrets** (`required: true`): Build fails if the secret is not found in Secrets Manager
- **Optional secrets** (`required: false`): Silently skipped if not found; the env var is not set

## Multi-Tenant Isolation

Each tenant (`orgId`) has its own secret namespace. This ensures:
- Tenant A cannot access Tenant B's secrets
- The same plugin can be used across tenants with different credentials
- Secret rotation is per-tenant without affecting other tenants

## Setup: Creating Secrets in AWS

Before running this pipeline, create the required secrets in AWS Secrets Manager:

```bash
# Create secrets for the tenant
aws secretsmanager create-secret \
  --name "pipeline-builder/acmecorp-tenant-001/NPM_TOKEN" \
  --secret-string "npm_XXXXXXXXXXXX"

aws secretsmanager create-secret \
  --name "pipeline-builder/acmecorp-tenant-001/SNYK_TOKEN" \
  --secret-string "snyk-api-token-here"

aws secretsmanager create-secret \
  --name "pipeline-builder/acmecorp-tenant-001/DOCKER_USERNAME" \
  --secret-string "acmecorp-docker"

aws secretsmanager create-secret \
  --name "pipeline-builder/acmecorp-tenant-001/DOCKER_PASSWORD" \
  --secret-string "docker-password-here"

aws secretsmanager create-secret \
  --name "pipeline-builder/acmecorp-tenant-001/SLACK_WEBHOOK_URL" \
  --secret-string "https://hooks.slack.com/services/XXXX/YYYY/ZZZZ"
```

## Usage

```typescript
const app = new cdk.App();
new SecretsManagementPipelineStack(app, 'SecretsManagementPipeline', {
  env: { account: '111111111111', region: 'us-east-1' },
});
```
