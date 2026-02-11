# Pipeline Builder

**An AWS CDK Construct Library for building CodePipeline infrastructure as code.**

Pipeline Builder is a type-safe, plugin-based construct library that simplifies the creation of AWS CodePipelines using AWS CDK. Define your CI/CD pipelines with a fluent TypeScript API, leverage reusable build plugins, and deploy CodePipeline infrastructure using standard CDK workflows. Optional supporting services provide configuration storage and management capabilities.

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
- [License](#license)

## Overview

Pipeline Builder is an **AWS CDK Construct library** for building CodePipeline infrastructure as code. At its core, this is a 100% AWS Construct solution that enables teams to:

- **Build AWS CodePipelines programmatically** using TypeScript/JavaScript with a fluent, type-safe API
- **Define pipeline infrastructure** using AWS CDK constructs and best practices
- **Create reusable plugins** for standardized build steps (synth, test, deploy, etc.)
- **Leverage metadata-driven configuration** for flexible pipeline definitions
- **Support multiple source types** including GitHub, CodeStar connections, and S3
- **Deploy pipelines to AWS** using standard CDK deployment workflows

The library includes supporting infrastructure (REST APIs, databases, web UI) for managing and storing pipeline configurations, but the core value proposition is the **AWS CDK construct library** that transforms configuration into deployed AWS CodePipeline infrastructure.

## Architecture

### AWS CDK Construct Library (Core Solution)

```
┌──────────────────────────────────────────────────────────────────────┐
│                     AWS CDK Construct Library                         │
│                        (pipeline-core)                                │
├──────────────────────────────────────────────────────────────────────┤
│                                                                       │
│  ┌────────────────┐      ┌─────────────────┐                        │
│  │ PipelineBuilder│─────▶│  AWS CodePipeline│                        │
│  │   (Construct)  │      │   Infrastructure │                        │
│  └────────┬───────┘      └─────────────────┘                        │
│           │                                                           │
│           ├──▶ SourceBuilder (GitHub, CodeStar, S3)                  │
│           ├──▶ StageBuilder (Pipeline Stages)                        │
│           ├──▶ PluginLookup (Reusable Build Steps)                   │
│           └──▶ MetadataBuilder (Configuration Management)            │
│                                                                       │
└──────────────────────────────────────────────────────────────────────┘
                              │
                              │ deploys to
                              ▼
                    ┌──────────────────────┐
                    │    AWS Account       │
                    │  ┌────────────────┐  │
                    │  │  CodePipeline  │  │
                    │  │  CodeBuild     │  │
                    │  │  S3 Artifacts  │  │
                    │  │  IAM Roles     │  │
                    │  └────────────────┘  │
                    └──────────────────────┘
```

### Supporting Infrastructure (Configuration Management)

The library includes optional supporting services for storing and managing pipeline configurations:

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
```

**Note**: The supporting services provide optional configuration storage and management capabilities, but the core solution is the **AWS CDK construct library** that creates CodePipeline infrastructure.

### Component Responsibilities

| Component | Purpose | Type |
|-----------|---------|------|
| **PipelineBuilder (CDK Construct)** | Core construct library for building AWS CodePipeline infrastructure | **Primary Solution** |
| **pipeline-core Package** | AWS CDK constructs, plugin system, source builders, metadata management | **Core Library** |
| **Pipeline Service** | Optional REST API for storing pipeline configurations | Supporting Service |
| **Plugin Service** | Optional REST API for managing reusable plugin definitions | Supporting Service |
| **Frontend** | Optional web UI for configuration management | Supporting Service |
| **Platform Service** | Optional authentication and organization management | Supporting Service |
| **Quota Service** | Optional rate limiting and usage tracking | Supporting Service |

## Key Features

> **Core Solution**: Pipeline Builder is an **AWS CDK Construct library** (100%) for building CodePipeline infrastructure. Supporting services are provided for optional configuration management.

### 🔧 AWS CDK Construct Library (Core Solution)

- **Type-safe construct library** for AWS CodePipeline infrastructure as code
- **Fluent builder API** with method chaining for clean, readable pipeline definitions
- **Multiple source types**: GitHub, CodeStar connections, S3 buckets
- **Plugin-based build steps** supporting both ShellStep and CodeBuildStep
- **Metadata-driven configuration** with full TypeScript type safety
- **Automatic resource naming** and tagging based on organization/project
- **Network configuration** support (VPC, security groups, subnets)
- **IAM role management** with customizable policies
- **Multi-stage pipelines** with parallel and sequential execution
- **CDK best practices** built-in (self-mutation, cross-account deployments, etc.)

### 🔌 Plugin System (Built into Constructs)

- **Reusable build step definitions** encapsulating common CI/CD tasks
- **Version management** with semantic versioning support
- **Metadata inheritance** from global to plugin-specific configuration
- **Dynamic plugin loading** from configuration or API
- **Extensible plugin types** supporting custom build environments
- **Multiple compute types** (SMALL, MEDIUM, LARGE, X_LARGE, X2_LARGE)
- **Environment variable management** at plugin and step levels
- **Command customization** (install, pre-build, build, post-build)

### 🏢 Multi-Tenancy (Supporting Services)

- **Organization-level isolation** in supporting services
- **Project-based pipeline grouping** for logical separation
- **Access modifiers** for sharing plugin configurations (PUBLIC, PRIVATE, ORGANIZATION)
- **Role-based access control** in optional API services

### 📊 Quota Management (Supporting Services)

- **Rate limiting** in optional API services
- **Usage tracking** for API calls, pipelines, and plugins
- **Configurable quota limits** per organization
- **Real-time monitoring** with Server-Sent Events

### 🔒 Security (Constructs + Services)

- **IAM role management** with least-privilege policies in CDK constructs
- **Cross-account deployment** support with proper role assumption
- **Artifact encryption** using AWS KMS
- **Secret management** via AWS Secrets Manager integration
- **JWT-based authentication** in supporting API services
- **HTTPS/TLS** encryption for optional web services

## Getting Started

### Quick Start: Using the CDK Construct Library

#### Installation

```bash
# Install the core construct library
npm install @mwashburn160/pipeline-core

# Or with pnpm
pnpm add @mwashburn160/pipeline-core

# Or with yarn
yarn add @mwashburn160/pipeline-core
```

#### Create Your First Pipeline

```typescript
import { App, Stack } from 'aws-cdk-lib';
import { PipelineBuilder } from '@mwashburn160/pipeline-core';

const app = new App();
const stack = new Stack(app, 'MyPipelineStack', {
  env: { account: '123456789012', region: 'us-east-1' }
});

new PipelineBuilder(stack, 'MyPipeline', {
  project: 'my-app',
  organization: 'my-org',
  synth: {
    source: {
      type: 'github',
      options: {
        repo: 'my-org/my-app',
        branch: 'main',
        connectionArn: 'arn:aws:codestar-connections:us-east-1:123456789012:connection/...'
      }
    },
    plugin: {
      name: 'nodejs-synth',
      version: '1.0.0'
    }
  }
});

app.synth();
```

#### Deploy to AWS

```bash
# Synthesize CloudFormation template
cdk synth

# Deploy the pipeline
cdk deploy
```

### Prerequisites

- **Node.js** >= 24.9.0
- **AWS CDK** >= 2.237.0
- **AWS Account** with appropriate permissions
- **AWS CLI** configured with credentials

## Usage Examples

### AWS CDK Constructs (Primary Use Case)

Most users interact with Pipeline Builder by **using the CDK construct library** to define infrastructure as code:

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

#### Using Plugins with Constructs

```typescript
import { PipelineBuilder } from '@mwashburn160/pipeline-core';

// Define reusable plugin inline
const testPlugin = {
  name: 'unit-tests',
  version: '1.0.0',
  pluginType: 'CodeBuildStep',
  commands: ['npm test'],
  env: { CI: 'true' }
};

new PipelineBuilder(stack, 'Pipeline', {
  project: 'api',
  organization: 'acme',
  synth: {
    source: {
      type: 'github',
      options: { repo: 'acme/api', branch: 'main' }
    },
    plugin: testPlugin
  }
});
```

#### Advanced: Custom Network Configuration

```typescript
new PipelineBuilder(stack, 'SecurePipeline', {
  project: 'secure-app',
  organization: 'enterprise',
  defaults: {
    vpc: { vpcId: 'vpc-12345' },
    securityGroups: [{ securityGroupId: 'sg-12345' }],
    subnetSelection: { subnetType: 'PRIVATE_WITH_EGRESS' }
  },
  synth: {
    source: { type: 's3', options: { bucket: 'source-bucket', objectKey: 'source.zip' } },
    plugin: { name: 'secure-build', version: '2.0.0' }
  }
});
```

#### Advanced: Using Metadata Keys with Custom IAM Roles

```typescript
import { PipelineBuilder } from '@mwashburn160/pipeline-core';
import { MetadataKeys } from '@mwashburn160/pipeline-core';
import { Role, ServicePrincipal, PolicyStatement, Effect } from 'aws-cdk-lib/aws-iam';
import { App, Stack } from 'aws-cdk-lib';

const app = new App();
const stack = new Stack(app, 'PipelineStack');

// Create a custom IAM role for the pipeline
const pipelineRole = new Role(stack, 'CustomPipelineRole', {
  assumedBy: new ServicePrincipal('codepipeline.amazonaws.com'),
  description: 'Custom role for CodePipeline with specific permissions',
});

// Add custom permissions to the role
pipelineRole.addToPolicy(new PolicyStatement({
  effect: Effect.ALLOW,
  actions: [
    'codebuild:BatchGetBuilds',
    'codebuild:StartBuild',
    's3:GetObject',
    's3:PutObject'
  ],
  resources: ['*']
}));

// Create a custom role for CodeBuild steps
const codeBuildRole = new Role(stack, 'CustomCodeBuildRole', {
  assumedBy: new ServicePrincipal('codebuild.amazonaws.com'),
  description: 'Custom role for CodeBuild with enhanced permissions',
});

codeBuildRole.addToPolicy(new PolicyStatement({
  effect: Effect.ALLOW,
  actions: [
    'secretsmanager:GetSecretValue',
    'ecr:GetAuthorizationToken',
    'ecr:BatchCheckLayerAvailability'
  ],
  resources: ['*']
}));

// Use metadata keys to pass role references to the pipeline
new PipelineBuilder(stack, 'Pipeline', {
  project: 'secure-app',
  organization: 'enterprise',

  // Global metadata with custom pipeline role
  global: {
    [MetadataKeys.PIPELINE_ROLE]: pipelineRole.roleArn,
    [MetadataKeys.CROSS_ACCOUNT_KEYS]: true,
    [MetadataKeys.ENABLE_KEY_ROTATION]: true,
    [MetadataKeys.DOCKER_ENABLED_FOR_SYNTH]: true,
    [MetadataKeys.SELF_MUTATION]: true,
    [MetadataKeys.PUBLISH_ASSETS_IN_PARALLEL]: true
  },

  synth: {
    source: {
      type: 'github',
      options: {
        repo: 'enterprise/secure-app',
        branch: 'main',
        connectionArn: 'arn:aws:codestar-connections:us-east-1:123456789012:connection/...'
      }
    },
    plugin: {
      name: 'build-synth',
      version: '1.0.0'
    },
    // Step-level metadata with custom CodeBuild role
    metadata: {
      [MetadataKeys.STEP_ROLE]: codeBuildRole.roleArn,
      [MetadataKeys.BUILD_ENVIRONMENT]: {
        computeType: 'BUILD_GENERAL1_LARGE',
        privileged: true
      },
      [MetadataKeys.TIMEOUT]: '60', // 60 minutes
      [MetadataKeys.CACHE]: {
        type: 'S3',
        location: 'my-cache-bucket/cache'
      }
    }
  },

  stages: [
    {
      stageName: 'Test',
      steps: [
        {
          name: 'integration-tests',
          plugin: { name: 'test-runner', version: '1.0.0' },
          metadata: {
            [MetadataKeys.STEP_ROLE]: codeBuildRole.roleArn,
            [MetadataKeys.COMMANDS]: [
              'npm run test:integration',
              'npm run test:e2e'
            ]
          }
        }
      ]
    }
  ]
});

app.synth();
```

**Key Metadata Constants Available:**

```typescript
// Pipeline-level metadata
MetadataKeys.PIPELINE_ROLE           // Custom pipeline IAM role
MetadataKeys.PIPELINE_NAME           // Override pipeline name
MetadataKeys.SELF_MUTATION           // Enable self-mutation
MetadataKeys.CROSS_ACCOUNT_KEYS      // Enable cross-account keys
MetadataKeys.ENABLE_KEY_ROTATION     // Enable KMS key rotation
MetadataKeys.DOCKER_ENABLED_FOR_SYNTH // Enable Docker for synth
MetadataKeys.PUBLISH_ASSETS_IN_PARALLEL // Parallel asset publishing

// CodeBuild step metadata
MetadataKeys.STEP_ROLE               // Custom CodeBuild role
MetadataKeys.ACTION_ROLE             // Custom action role
MetadataKeys.BUILD_ENVIRONMENT       // Build environment config
MetadataKeys.TIMEOUT                 // Build timeout
MetadataKeys.CACHE                   // Build cache configuration
MetadataKeys.COMMANDS                // Build commands
MetadataKeys.INSTALL_COMMANDS        // Install commands
MetadataKeys.PROJECT_NAME            // CodeBuild project name
```

---

### Supporting Services (Optional Configuration Storage)

For teams that want to manage pipeline configurations through REST APIs:

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
    "commands": ["npm run build", "npm run test"],
    "env": { "NODE_ENV": "production" }
  }'
```

#### Retrieving Pipeline Configuration

```typescript
import { pipelineService } from '@mwashburn160/pipeline-core';

// Fetch configuration from API service
const config = await pipelineService.getDefaultForProject('my-org', 'my-project');

// Use configuration with CDK construct
new PipelineBuilder(stack, 'Pipeline', config.config);
```

## Package Structure

```
pipeline-builder/
├── packages/
│   ├── pipeline-core/     # ⭐ AWS CDK constructs (CORE LIBRARY)
│   ├── pipeline-data/     # Database schemas, ORM, services (supporting)
│   ├── api-core/          # Core utilities, auth, logging (supporting)
│   ├── api-server/        # Express infrastructure, SSE (supporting)
│   └── pipeline-manager/  # CLI tool for pipeline management (supporting)
├── api/
│   ├── pipeline/          # Pipeline config CRUD service (supporting)
│   ├── plugin/            # Plugin definition CRUD service (supporting)
│   └── quota/             # Quota tracking service (supporting)
├── platform/              # Platform/auth service (supporting)
├── frontend/              # Next.js React UI (supporting)
├── deploy/
│   └── local/             # Docker Compose setup (supporting)
└── .github/
    └── workflows/         # CI/CD workflows
```

### Core Package: AWS CDK Constructs

#### [@mwashburn160/pipeline-core](packages/pipeline-core) ⭐ **Primary Solution**

The core AWS CDK construct library for building CodePipeline infrastructure:

**Constructs:**
- `PipelineBuilder` - Main construct for creating AWS CodePipeline
- `SourceBuilder` - Handles GitHub, CodeStar, and S3 source configurations
- `StageBuilder` - Creates pipeline stages with build/test/deploy steps
- `PluginLookup` - Resolves and applies reusable plugin configurations
- `MetadataBuilder` - Manages metadata-driven configuration

**Features:**
- Type-safe TypeScript API
- Plugin-based build steps (ShellStep, CodeBuildStep)
- Multi-source support (GitHub, CodeStar, S3)
- Automatic IAM role and policy management
- VPC and network configuration support
- Cross-account deployment capabilities
- Metadata inheritance and merging
- CDK best practices built-in

**Usage:**
```typescript
import { PipelineBuilder } from '@mwashburn160/pipeline-core';

new PipelineBuilder(stack, 'Pipeline', {
  project: 'my-app',
  organization: 'my-org',
  synth: {
    source: { type: 'github', options: { repo: 'owner/repo' } },
    plugin: { name: 'build-plugin' }
  }
});
```

### Supporting Packages

#### [@mwashburn160/pipeline-data](packages/pipeline-data)

Optional database layer for configuration persistence:
- Drizzle ORM schemas for pipelines and plugins
- PostgreSQL connection management with retry logic
- Service layer (CrudService base class)
- Query builders with filtering, pagination, sorting
- Multi-tenant access control

#### [@mwashburn160/api-core](packages/api-core)

Foundation utilities for supporting services:
- JWT authentication middleware
- Request/response utilities
- Error handling and logging
- Parameter parsing
- HTTP client for internal service communication

#### [@mwashburn160/api-server](packages/api-server)

Express server infrastructure for supporting services:
- Application factory with security middleware
- Server lifecycle management
- Server-Sent Events (SSE) for real-time updates
- Request context creation
- Graceful shutdown handling

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

## License

This project is licensed under the Apache License 2.0 - see the [LICENSE](LICENSE) file for details.

---

## What Makes This a 100% AWS Construct Solution?

Pipeline Builder is fundamentally an **AWS CDK Construct Library**:

✅ **Core Value**: The `PipelineBuilder` construct creates AWS CodePipeline infrastructure
✅ **Primary Use Case**: Import the library and define pipelines in CDK TypeScript code
✅ **Deployment**: Uses standard `cdk deploy` workflow to create AWS resources
✅ **Infrastructure as Code**: Full infrastructure defined in type-safe TypeScript
✅ **AWS Native**: Builds on AWS CDK best practices and patterns

📦 **Supporting Services**: The REST APIs, databases, and web UI are optional configuration storage layers that complement the core construct library but are not required to use Pipeline Builder.

---

**Built with ❤️ using AWS CDK, TypeScript, and Infrastructure as Code Best Practices**
