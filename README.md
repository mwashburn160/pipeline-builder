# Pipeline Builder

A full-stack platform for creating, deploying, and managing CI/CD pipelines on AWS. Built as a TypeScript monorepo, it provides a web UI, REST APIs, a CLI tool, and AWS CDK infrastructure — all tied together with Docker-based local development.

## Solution Overview

At its core, Pipeline Builder provides a **native AWS CDK construct** that synthesizes fully configured CodePipeline infrastructure from a simple configuration object (`BuilderProps`). The construct itself is roughly 10% of the overall solution — the remaining 90% is the platform that surrounds it: a multi-tenant API layer, a web UI with wizard-based pipeline creation, a plugin system for containerized build steps, quota enforcement, and a CLI tool.

### The CDK Construct

The `PipelineBuilder` construct extends CDK's `Construct` class directly — it is not a wrapper around CodePipeline but a native CDK resource that composes CodePipeline, CodeBuild, IAM roles, VPC networking, and security groups into a single deployable unit. It accepts a `BuilderProps` configuration and handles:

- Source resolution (S3, GitHub, CodeStar connections)
- Plugin-based build step synthesis (each step is a containerized plugin)
- Multi-stage pipeline definition with waves
- Network configuration (VPC, subnets, security groups)
- IAM role management
- Metadata-driven property overrides

### Two Ways to Define Pipelines

**Wizard-Based Form Builder** — The frontend provides a guided multi-section form for building pipelines visually:

1. **Core** — Project, organization, pipeline name
2. **Synth** — Source type and plugin configuration
3. **Defaults** — Network, security groups, and global metadata
4. **Role** — IAM role configuration
5. **Stages** — Add stages and steps with per-step plugins, env vars, and commands

The form validates in real-time and assembles the final `BuilderProps` JSON automatically.

**Metadata Keys** — For advanced control, users can set key-value metadata pairs that override CDK construct properties without modifying code. Keys follow the format `aws:cdk:{namespace}:{property}` and cover 50+ configurable properties across CodePipeline, CodeBuild, networking, IAM, and security groups. Metadata can be applied at the global, defaults, synth, or per-step level — with later values taking precedence.

```
aws:cdk:pipelines:codepipeline:selfmutation → true
aws:cdk:codebuild:buildenvironment:privileged → true
aws:cdk:ec2:network:vpcid → vpc-abc123
```

Both approaches produce the same `BuilderProps` JSON, which is stored in PostgreSQL and passed to the CDK construct at deploy time.

### Example: BuilderProps via CLI

A simple pipeline that pulls from GitHub and runs a synth plugin:

```json
{
  "project": "my-app",
  "organization": "my-org",
  "synth": {
    "source": {
      "type": "github",
      "options": { "repo": "my-org/my-app", "branch": "main" }
    },
    "plugin": { "name": "cdk-synth" }
  },
  "stages": [
    {
      "stageName": "Test",
      "steps": [
        {
          "plugin": { "name": "unit-test" },
          "env": { "NODE_ENV": "test" }
        }
      ]
    }
  ]
}
```

Save this as `pipeline.json`, then create and deploy:

```bash
pipeline-manager create-pipeline --file pipeline.json
pipeline-manager deploy --pipeline-id <uuid>
```

### Example: CDK Role via Metadata Keys

Create an IAM role in a separate CDK stack, then reference it in a pipeline using metadata keys — no code changes required:

```typescript
// In a separate CDK stack
const pipelineRole = new iam.Role(this, 'PipelineRole', {
  assumedBy: new iam.ServicePrincipal('codepipeline.amazonaws.com'),
  roleName: 'my-pipeline-role',
});
pipelineRole.addManagedPolicy(
  iam.ManagedPolicy.fromAwsManagedPolicyName('AWSCodePipeline_FullAccess'),
);
```

Then pass the role to the pipeline via `BuilderProps.role`:

```json
{
  "project": "my-app",
  "organization": "my-org",
  "role": {
    "type": "roleArn",
    "options": {
      "roleArn": "arn:aws:iam::123456789012:role/my-pipeline-role",
      "mutable": false
    }
  },
  "synth": {
    "source": {
      "type": "github",
      "options": { "repo": "my-org/my-app", "branch": "main" }
    },
    "plugin": {
      "name": "cdk-synth",
      "metadata": {
        "aws:cdk:pipelines:codepipeline:selfmutation": true,
        "aws:cdk:pipelines:codepipeline:dockerenabledforsynth": true,
        "aws:cdk:codebuild:buildenvironment:privileged": true,
        "aws:cdk:codebuild:buildenvironment:computetype": "BUILD_GENERAL1_MEDIUM"
      }
    }
  }
}
```

The `role` field uses the discriminated union pattern (`roleArn`, `roleName`, or `codeBuildDefault`) to resolve the IAM role at synth time. Metadata keys on the plugin override CDK construct properties — here enabling self-mutation, Docker support, privileged mode, and a larger compute type — all without modifying the construct code.

### Key Capabilities

- **Pipeline Management** — Create, update, and deploy pipelines scoped to organizations and projects. Supports public/private access, default pipeline selection, and configuration via wizard or metadata keys.
- **Plugin System** — Upload ZIP archives containing a `manifest.yaml` and `Dockerfile`. The platform builds and pushes Docker images to a registry, storing plugin metadata for use in pipelines.
- **Quota Enforcement** — Per-organization limits on pipelines, plugins, and API calls with window-based rate limiting and automatic resets.
- **Multi-Tenant Organizations** — User registration, JWT authentication, role-based access (member/admin/system admin), organization invitations, and ownership transfer.
- **Real-Time Updates** — Server-Sent Events (SSE) for streaming progress during long-running operations like pipeline deployments.

## Architecture

```
                         ┌──────────────┐
                         │    NGINX     │
                         │  8080/8443   │
                         └──────┬───────┘
                                │
            ┌───────────┬───────┼───────┬───────────┐
            │           │       │       │           │
      ┌─────┴─────┐ ┌───┴───┐ ┌┴────┐ ┌┴─────┐ ┌───┴────┐
      │ Frontend  │ │Platform│ │Pipe-│ │Plugin│ │ Quota  │
      │ (Next.js) │ │  API   │ │line │ │ API  │ │  API   │
      │  :3000    │ │ :3000  │ │:3000│ │:3000 │ │ :3000  │
      └───────────┘ └───┬───┘ └──┬──┘ └──┬───┘ └───┬────┘
                        │        │       │         │
                   ┌────┴────┐ ┌─┴───────┴──┐  ┌───┴───┐
                   │ MongoDB │ │ PostgreSQL  │  │MongoDB│
                   │ (users, │ │ (pipelines, │  │(quota)│
                   │  orgs)  │ │  plugins)   │  │       │
                   └─────────┘ └────────────┘  └───────┘
```

NGINX acts as the reverse proxy and TLS terminator. Each service runs in its own container with health checks, resource limits, and network isolation.

## Packages

The monorepo contains four shared packages with a strict dependency order:

| Package | Purpose | Dependencies |
|---------|---------|-------------|
| **api-core** | Auth middleware (JWT), HTTP client, response utilities, logging, error codes, quota client | None (internal) |
| **pipeline-data** | Drizzle ORM schemas, PostgreSQL connection, query builders, filters | api-core |
| **pipeline-core** | AWS CDK constructs, app configuration, pipeline types, network resolution | api-core, pipeline-data |
| **api-server** | Express app factory, server lifecycle, SSE manager, request context, rate limiting | api-core, pipeline-core |

## Services

### Platform (port 3000)

Main API service handling authentication and organization management.

| Endpoint | Description |
|----------|-------------|
| `POST /api/auth/register` | User registration |
| `POST /api/auth/login` | Login (returns JWT) |
| `POST /api/auth/refresh` | Refresh access token |
| `GET /api/user/profile` | User profile |
| `POST /api/organization` | Create organization |
| `GET /api/organization/:id/members` | List members |
| `POST /api/invitation` | Invite user to org |

### Pipeline API (port 3000)

CRUD operations for pipeline configurations.

| Endpoint | Description |
|----------|-------------|
| `GET /pipelines` | List with filtering, pagination, sorting |
| `GET /pipelines/:id` | Get by ID |
| `POST /pipelines` | Create pipeline (quota-checked) |
| `PUT /pipelines/:id` | Update pipeline |
| `DELETE /pipelines/:id` | Soft delete (admin only) |

### Plugin API (port 3000)

Plugin upload, Docker image building, and metadata management.

| Endpoint | Description |
|----------|-------------|
| `GET /plugins` | List with filtering, pagination, sorting |
| `GET /plugins/:id` | Get by ID |
| `POST /plugins` | Upload ZIP, build image, push to registry |
| `PUT /plugins/:id` | Update plugin metadata |
| `DELETE /plugins/:id` | Soft delete (admin only) |

### Quota API (port 3000)

Per-organization resource quota tracking and enforcement.

| Endpoint | Description |
|----------|-------------|
| `GET /quotas` | Own org quotas |
| `GET /quotas/all` | All orgs (system admin) |
| `GET /quotas/:orgId/:type` | Specific quota type |
| `PUT /quotas/:orgId` | Update limits (system admin) |
| `POST /quotas/:orgId/reset` | Reset usage counters |

### Frontend (port 3000)

Next.js web application with Tailwind CSS.

**Pages:** Login, Register, Dashboard, Pipelines, Plugins, Organizations, Quotas, Users, Settings, API Tokens

## CLI Tool

The `pipeline-manager` CLI provides command-line access to the platform.

```bash
# List pipelines with filters
pipeline-manager list-pipelines --project my-app --is-active true --format json

# List plugins
pipeline-manager list-plugins --name-pattern "auth*" --limit 20

# Get a specific pipeline
pipeline-manager get-pipeline --id <uuid>

# Upload a plugin
pipeline-manager upload-plugin --file ./my-plugin.zip

# Deploy a pipeline via CDK
pipeline-manager deploy --pipeline-id <uuid>
```

**Environment:** Set `PLATFORM_TOKEN` for authentication and optionally `PLATFORM_BASE_URL` for the API endpoint.

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Node.js 24, TypeScript 5.9 |
| API Framework | Express 5 |
| Frontend | Next.js 16, React, Tailwind CSS 4 |
| ORM | Drizzle ORM (PostgreSQL) |
| ODM | Mongoose (MongoDB) |
| Infrastructure | AWS CDK 2, Docker |
| Auth | JWT (jsonwebtoken) |
| Logging | Winston |
| Build | Projen, NX, pnpm workspaces |
| CI/CD | GitHub Actions |

## Local Development

### Prerequisites

- Node.js 24.9+
- pnpm 10+
- Docker & Docker Compose

### Setup

```bash
# Install dependencies
pnpm install

# Generate project files
pnpm dlx projen

# Build all packages (respects dependency order)
npx nx run-many --target=build --all

# Start local infrastructure
docker compose -f deploy/local/docker-compose.yml up -d
```

### Build Order

Packages build in dependency order: api-core → pipeline-data → pipeline-core → api-server → services/frontend.

### Local Services

| Service | URL |
|---------|-----|
| API Gateway | https://localhost:8443 |
| Frontend | https://localhost:8443 |
| pgAdmin | http://localhost:5480 |
| Mongo Express | http://localhost:27081 |
| Registry UI | http://localhost:5080 |

## API Response Format

All services use a standardized response format:

```json
// Success
{ "success": true, "statusCode": 200, "data": { ... } }

// Error
{ "success": false, "statusCode": 400, "error": "message", "code": "INVALID_REQUEST" }

// Paginated
{ "success": true, "statusCode": 200, "data": [...], "total": 100, "hasMore": true }
```

## Project Structure

```
pipeline-builder/
├── packages/
│   ├── api-core/          # Shared API utilities
│   ├── api-server/        # Express infrastructure
│   ├── pipeline-core/     # CDK + configuration
│   ├── pipeline-data/     # Database layer
│   └── pipeline-manager/  # CLI tool
├── api/
│   ├── pipeline/          # Pipeline service
│   ├── plugin/            # Plugin service
│   └── quota/             # Quota service
├── platform/              # Platform service
├── frontend/              # Next.js web app
├── deploy/
│   └── local/             # Docker Compose + NGINX config
└── .projenrc.ts           # Monorepo configuration
```
