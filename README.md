# Pipeline Builder

A comprehensive platform for creating, managing, and deploying AWS CDK Pipelines with a microservices architecture. Pipeline Builder simplifies the process of building continuous deployment pipelines by providing a plugin-based system, multi-tenant support, and a modern web interface.

[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D24.9.0-brightgreen.svg)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9.3-blue.svg)](https://www.typescriptlang.org)
[![AWS CDK](https://img.shields.io/badge/AWS%20CDK-2.237.0-orange.svg)](https://aws.amazon.com/cdk)

## Table of Contents

- [Overview](#overview)
- [Architecture](#architecture)
- [Key Features](#key-features)
- [Getting Started](#getting-started)
- [Usage Examples](#usage-examples)
- [Package Structure](#package-structure)
- [API Reference](#api-reference)
- [Development](#development)
- [Contributing](#contributing)
- [License](#license)

## Overview

Pipeline Builder is a **complete platform** for managing AWS CDK Pipelines, not just a CDK construct library. While it includes AWS CDK constructs (~10% of the codebase), the majority of the solution is a full-featured microservices platform that enables teams to:

- **Build CDK Pipelines programmatically** using TypeScript/JavaScript with a fluent API
- **Manage pipeline configurations** through REST APIs with full CRUD operations
- **Create reusable plugins** for common build steps (synth, test, deploy, etc.)
- **Support multi-tenancy** with organization-level isolation and access control
- **Monitor quotas and usage** with built-in rate limiting and quota management
- **Deploy locally or to AWS** with Docker Compose for development and AWS CDK for production
- **Web-based UI** for non-technical users to manage pipelines
- **Plugin marketplace** for sharing and discovering build configurations

The platform uses a microservices architecture where each service has a specific responsibility, making it scalable, maintainable, and easy to extend. The AWS CDK constructs are just one component—the real value is in the complete ecosystem for pipeline lifecycle management.

## Architecture

### Complete Platform (90% of Solution)

```
┌─────────────────────────────────────────────────────────────────────┐
│                          NGINX Reverse Proxy                        │
│                    (SSL/TLS, JWT Auth, Load Balancing)              │
└────────┬───────────────────┬──────────────────┬──────────────┬──────┘
         │                   │                  │              │
         │                   │                  │              │
    ┌────▼────┐         ┌────▼────┐      ┌─────▼─────┐   ┌───▼────┐
    │Frontend │         │Platform │      │  Plugin   │   │Pipeline│
    │ (Next.js│         │ Service │      │  Service  │   │Service │
    │  React) │         │         │      │           │   │        │
    └─────────┘         └────┬────┘      └─────┬─────┘   └────┬───┘
                             │                  │              │
                        ┌────▼──────────────────▼──────────────▼────┐
                        │           PostgreSQL Database             │
                        │    (Pipelines, Plugins, Users, Orgs)      │
                        └───────────────────────────────────────────┘
         │
    ┌────▼────┐
    │  Quota  │
    │ Service │
    └────┬────┘
         │
    ┌────▼────────┐
    │   MongoDB   │
    │   (Quotas)  │
    └─────────────┘

┌──────────────────────────────────────────────────────────────────────┐
│                         Core Packages (90%)                           │
├──────────────────────────────────────────────────────────────────────┤
│ api-core        │ Shared utilities, auth, logging, error handling    │
│ api-server      │ Express infrastructure, SSE, middleware            │
│ pipeline-data   │ Database schemas, ORM, query builders, services    │
└──────────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────────┐
│                      AWS CDK Constructs (10%)                         │
├──────────────────────────────────────────────────────────────────────┤
│ pipeline-core   │ CDK constructs, pipeline builder, plugin system    │
└──────────────────────────────────────────────────────────────────────┘
```

**Note**: The AWS CDK constructs in `pipeline-core` represent only ~10% of the codebase. The majority of the platform is the **microservices infrastructure** (REST APIs, database layer, authentication, quota management, web UI) that makes pipeline management accessible and scalable.

### Service Responsibilities

| Service | Port | Database | Purpose | % of Solution |
|---------|------|----------|---------|---------------|
| **Frontend** | 3001 | - | Next.js React application for pipeline management UI | ~25% |
| **Platform Service** | 3000 | PostgreSQL | User authentication, organization management, system administration | ~20% |
| **Pipeline Service** | 3000 | PostgreSQL | CRUD operations for pipeline configurations | ~15% |
| **Plugin Service** | 3000 | PostgreSQL | CRUD operations for reusable plugin definitions | ~15% |
| **Quota Service** | 3000 | MongoDB | Rate limiting, quota tracking, usage monitoring | ~10% |
| **NGINX** | 8080/8443 | - | Reverse proxy, SSL termination, JWT validation | ~5% |
| **CDK Constructs** | - | - | AWS CodePipeline builder (pipeline-core package) | **~10%** |

**Total Platform**: 90% microservices + infrastructure, **10% AWS CDK constructs**

## Key Features

> **Important**: Pipeline Builder is a **complete platform** (90%) with embedded AWS CDK constructs (10%), not just a construct library. You get a full microservices ecosystem for managing pipeline lifecycles.

### 🌐 Complete Platform (90% of Solution)

- **REST APIs** for full CRUD operations on pipelines and plugins
- **Web-based UI** built with Next.js and React for non-developers
- **Multi-service architecture** with dedicated microservices
- **Database persistence** with PostgreSQL and MongoDB
- **Authentication & authorization** with JWT and role-based access
- **Quota management** with rate limiting and usage tracking
- **Real-time updates** via Server-Sent Events (SSE)
- **Plugin marketplace** for sharing build configurations
- **Audit logging** with full change history
- **Docker deployment** for local development and testing

### 🔧 CDK Pipeline Builder (10% of Solution)

- **Fluent API** for building AWS CodePipeline configurations
- **Multiple source types**: GitHub, CodeStar, S3
- **Plugin-based steps** with support for ShellStep and CodeBuildStep
- **Metadata-driven** configuration with type safety
- **Automatic tagging** and resource naming

### 🔌 Plugin System

- **Reusable build configurations** for common tasks
- **Version management** with semantic versioning
- **Access control** (public, private, organization-scoped)
- **Flexible metadata** storage with JSONB
- **Support for multiple compute types** (SMALL, MEDIUM, LARGE, X_LARGE, X2_LARGE)

### 🏢 Multi-Tenancy

- **Organization-level isolation** for teams and departments
- **Project-based grouping** within organizations
- **Access modifiers** (PUBLIC, PRIVATE, ORGANIZATION)
- **Role-based access control** (admin, user)

### 📊 Quota Management

- **Rate limiting** per organization
- **Usage tracking** for API calls, pipelines, and plugins
- **Configurable limits** per quota type
- **Real-time monitoring** with Server-Sent Events (SSE)

### 🔒 Security

- **JWT-based authentication** with refresh tokens
- **HTTPS/TLS** encryption in production
- **CORS protection** with configurable origins
- **SQL injection prevention** with Drizzle ORM
- **Helmet.js** security headers

## Getting Started

### Prerequisites

- **Node.js** >= 24.9.0
- **PNPM** 10.25.0+
- **Docker** and Docker Compose (for local development)
- **AWS Account** (for deployment)

### Local Development Setup

1. **Clone the repository**

```bash
git clone https://github.com/mwashburn160/pipeline-builder.git
cd pipeline-builder
```

2. **Install dependencies**

```bash
pnpm install
```

3. **Configure environment**

```bash
cd deploy/local
cp .env.example .env
# Edit .env with your configuration
```

4. **Start services with Docker Compose**

```bash
cd deploy/local
docker-compose up -d
```

5. **Access the application**

- Frontend: https://localhost:8443
- API Gateway: https://localhost:8443/api
- Mongo Express: http://localhost:27081
- pgAdmin: http://localhost:5050

## Usage Examples

### Platform APIs (Primary Use Case - 90% of Users)

Most users interact with Pipeline Builder through the **REST APIs** or **Web UI**, not directly with CDK constructs:

#### Creating a Plugin via API

```bash
curl -X POST https://localhost:8443/api/plugins \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -d '{
    "name": "nodejs-build",
    "version": "1.0.0",
    "description": "Build Node.js application",
    "pluginType": "CodeBuildStep",
    "computeType": "SMALL",
    "installCommands": ["npm ci"],
    "commands": [
      "npm run build",
      "npm run test"
    ],
    "env": {
      "NODE_ENV": "production"
    },
    "accessModifier": "ORGANIZATION"
  }'
```

#### Listing Pipelines

```bash
# Get all pipelines for an organization
curl -X GET "https://localhost:8443/api/pipelines?orgId=my-org&limit=10&offset=0" \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"

# Find a specific pipeline by name
curl -X GET "https://localhost:8443/api/pipelines/find?name=my-pipeline&orgId=my-org" \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

#### Managing Pipeline Configuration

```javascript
// Create a pipeline configuration
const pipeline = await fetch('https://localhost:8443/api/pipelines', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`
  },
  body: JSON.stringify({
    name: 'frontend-pipeline',
    orgId: 'acme-corp',
    project: 'web-app',
    description: 'Frontend deployment pipeline',
    config: {
      organization: 'acme-corp',
      project: 'web-app',
      synth: {
        source: {
          type: 'github',
          options: { repo: 'acme-corp/frontend', branch: 'main' }
        },
        plugin: { name: 'react-build' }
      }
    },
    isDefault: true
  })
});
```

#### Service Layer Usage (TypeScript)

```typescript
import { pipelineService, pluginService } from '@mwashburn160/pipeline-core';

// Find all pipelines for a project
const pipelines = await pipelineService.findByProject('my-org', 'my-project');

// Get default pipeline
const defaultPipeline = await pipelineService.getDefaultForProject('my-org', 'my-project');

// Find plugin by name and version
const plugin = await pluginService.findByNameAndVersion('jest-test', '1.0.0', 'my-org');

// Set default plugin for organization
await pluginService.setDefaultForOrg('my-org', pluginId, userId);
```

---

### CDK Constructs (Advanced Use Case - 10% of Users)

For advanced users who need to **build CDK infrastructure directly**:

#### Building a Pipeline with CDK

```typescript
import { PipelineBuilder } from '@mwashburn160/pipeline-core';
import { App, Stack } from 'aws-cdk-lib';

const app = new App();
const stack = new Stack(app, 'MyPipelineStack');

// Create a pipeline with GitHub source
new PipelineBuilder(stack, 'MyPipeline', {
  project: 'my-app',
  organization: 'my-org',
  synth: {
    source: {
      type: 'github',
      options: {
        repo: 'owner/repo',
        branch: 'main',
        connectionArn: 'arn:aws:codestar-connections:...'
      }
    },
    plugin: {
      name: 'nodejs-synth',
      version: '1.0.0'
    }
  },
  stages: [
    {
      stageName: 'Test',
      steps: [
        {
          name: 'unit-tests',
          plugin: { name: 'jest-test', version: '1.0.0' }
        }
      ]
    },
    {
      stageName: 'Deploy',
      steps: [
        {
          name: 'deploy-prod',
          plugin: { name: 'cdk-deploy', version: '1.0.0' },
          env: { ENVIRONMENT: 'production' }
        }
      ]
    }
  ]
});

app.synth();
```

## Package Structure

```
pipeline-builder/
├── packages/
│   ├── api-core/          # Core utilities, auth, logging, error handling
│   ├── api-server/        # Express infrastructure, SSE, middleware
│   ├── pipeline-data/     # Database schemas, ORM, query builders, services
│   ├── pipeline-core/     # CDK constructs, pipeline builder
│   └── pipeline-manager/  # CLI tool for pipeline management
├── api/
│   ├── pipeline/          # Pipeline CRUD service
│   ├── plugin/            # Plugin CRUD service
│   └── quota/             # Quota tracking service
├── platform/              # Platform/auth service
├── frontend/              # Next.js React UI
├── deploy/
│   └── local/             # Docker Compose setup
└── .github/
    └── workflows/         # CI/CD workflows
```

### Core Packages

#### [@mwashburn160/api-core](packages/api-core)

Foundation package providing:
- JWT authentication middleware
- Request/response utilities
- Error handling and logging
- Parameter parsing
- HTTP client for internal service communication

#### [@mwashburn160/api-server](packages/api-server)

Express server infrastructure:
- Application factory with security middleware
- Server lifecycle management
- Server-Sent Events (SSE) for real-time updates
- Request context creation
- Graceful shutdown handling

#### [@mwashburn160/pipeline-data](packages/pipeline-data)

Database layer with:
- Drizzle ORM schemas for pipelines and plugins
- PostgreSQL connection management with retry logic
- Service layer (CrudService base class)
- Query builders with filtering, pagination, sorting
- Multi-tenant access control

#### [@mwashburn160/pipeline-core](packages/pipeline-core)

CDK infrastructure package:
- PipelineBuilder construct for creating CodePipelines
- Plugin system for reusable build steps
- Configuration management
- Source builders (GitHub, CodeStar, S3)
- Metadata-driven pipeline configuration

## API Reference

### Pipeline Service API

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/pipelines` | List pipelines with filtering, pagination, sorting |
| GET | `/pipelines/find` | Find single pipeline by query parameters |
| GET | `/pipelines/:id` | Get pipeline by UUID |
| POST | `/pipelines` | Create new pipeline |
| PUT | `/pipelines/:id` | Update existing pipeline |
| DELETE | `/pipelines/:id` | Delete pipeline (admin only) |

### Plugin Service API

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/plugins` | List plugins with filtering, pagination, sorting |
| GET | `/plugins/find` | Find single plugin by query parameters |
| GET | `/plugins/:id` | Get plugin by UUID |
| POST | `/plugins` | Create new plugin |
| PUT | `/plugins/:id` | Update existing plugin |
| DELETE | `/plugins/:id` | Delete plugin (admin only) |

### Quota Service API

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/quota/check` | Check if action is allowed under quota |
| POST | `/quota/track` | Record usage of a quota type |
| GET | `/quota/:orgId` | Get quota status for organization |

### Common Query Parameters

- `orgId` - Organization filter
- `project` - Project filter
- `name` - Name filter (exact match)
- `isDefault` - Filter by default status
- `accessModifier` - Filter by access level (PUBLIC, PRIVATE, ORGANIZATION)
- `limit` - Page size (default: 10)
- `offset` - Pagination offset (default: 0)
- `sortBy` - Sort field (createdAt, updatedAt, name)
- `sortOrder` - Sort direction (asc, desc)

## Development

### Build All Packages

```bash
pnpm build
```

### Run Tests

```bash
pnpm test
```

### Watch Mode

```bash
pnpm watch
```

### Type Checking

```bash
pnpm compile
```

### Linting

```bash
pnpm eslint
```

### Update Dependencies

```bash
pnpm upgrade
```

### Generate Projen Configuration

```bash
pnpm dlx projen
```

## Technology Stack

- **Language**: TypeScript 5.9.3
- **Runtime**: Node.js >= 24.9.0
- **Package Manager**: PNPM 10.25.0
- **Build Tool**: Projen
- **Monorepo**: PNPM Workspaces + Nx
- **Web Framework**: Express.js 5.2.1
- **Frontend**: Next.js 15 + React 19
- **Database**: PostgreSQL 16+ (pipelines, plugins), MongoDB 8+ (quotas)
- **ORM**: Drizzle ORM 0.45.1
- **Infrastructure**: AWS CDK 2.237.0
- **Testing**: Jest 30.2.0
- **Logging**: Winston
- **Security**: Helmet.js, CORS, JWT

## Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'feat: add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

Please ensure:
- All tests pass (`pnpm test`)
- Code follows TypeScript/ESLint standards
- Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/)
- Documentation is updated for new features

## License

This project is licensed under the Apache License 2.0 - see the [LICENSE](LICENSE) file for details.

---

**Built with ❤️ using AWS CDK, TypeScript, and Modern DevOps Practices**
