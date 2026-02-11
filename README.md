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

Pipeline Builder is a **100% AWS CDK Construct library** for building CodePipeline infrastructure as code. This is fundamentally a construct library, not a SaaS platform or managed service.

### Why 100% AWS Construct?

✅ **Pure Infrastructure as Code** - The `PipelineBuilder` construct creates actual AWS CodePipeline infrastructure in your AWS account
✅ **Standard CDK Workflow** - Install the library, import constructs, define pipelines in TypeScript, deploy with `cdk deploy`
✅ **Direct AWS Resource Creation** - Generates CloudFormation templates that provision CodePipeline, CodeBuild, S3, and IAM resources
✅ **Type-Safe Configuration** - Full TypeScript type safety with fluent builder API for readable pipeline definitions
✅ **AWS Native** - Builds on AWS CDK best practices and integrates seamlessly with existing CDK applications

### Core Capabilities

- **Build AWS CodePipelines programmatically** using TypeScript/JavaScript with a fluent, type-safe API
- **Define pipeline infrastructure** using AWS CDK constructs and best practices
- **Create reusable plugins** for standardized build steps (synth, test, deploy, etc.)
- **Leverage metadata-driven configuration** for flexible pipeline definitions
- **Support multiple source types** including GitHub, CodeStar connections, and S3
- **Deploy pipelines to AWS** using standard CDK deployment workflows

### Optional Supporting Services

The library includes optional supporting infrastructure (REST APIs, databases, web UI) for storing and managing pipeline configurations as reusable templates. These services are **not required** to use Pipeline Builder - the core value is the **AWS CDK construct library** that transforms configuration into deployed AWS CodePipeline infrastructure.

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
// ── CodePipeline Configuration ──
MetadataKeys.SELF_MUTATION                      // Enable self-mutation
MetadataKeys.CROSS_ACCOUNT_KEYS                 // Enable cross-account keys
MetadataKeys.DOCKER_ENABLED_FOR_SELF_MUTATION   // Enable Docker for self-mutation
MetadataKeys.DOCKER_ENABLED_FOR_SYNTH           // Enable Docker for synth
MetadataKeys.ENABLE_KEY_ROTATION                // Enable KMS key rotation
MetadataKeys.PUBLISH_ASSETS_IN_PARALLEL         // Parallel asset publishing
MetadataKeys.REUSE_CROSS_REGION_SUPPORT_STACKS  // Reuse cross-region support stacks
MetadataKeys.USE_CHANGE_SETS                    // Use CloudFormation change sets
MetadataKeys.USE_PIPELINE_ROLE_FOR_ACTIONS      // Use pipeline role for actions
MetadataKeys.ARTIFACT_BUCKET                    // Custom artifact bucket
MetadataKeys.ASSET_PUBLISHING_CODE_BUILD_DEFAULTS // Asset publishing CodeBuild defaults
MetadataKeys.CDK_ASSETS_CLI_VERSION             // CDK assets CLI version
MetadataKeys.CLI_VERSION                        // CDK CLI version
MetadataKeys.CODE_BUILD_DEFAULTS                // CodeBuild defaults for all steps
MetadataKeys.CODE_PIPELINE                      // CodePipeline construct reference
MetadataKeys.CROSS_REGION_REPLICATION_BUCKETS   // Cross-region replication buckets
MetadataKeys.DOCKER_CREDENTIALS                 // Docker registry credentials
MetadataKeys.PIPELINE_NAME                      // Override pipeline name
MetadataKeys.PIPELINE_TYPE                      // Pipeline type (V1, V2)
MetadataKeys.PIPELINE_ROLE                      // Custom pipeline IAM role
MetadataKeys.SELF_MUTATION_CODE_BUILD_DEFAULTS  // Self-mutation CodeBuild defaults
MetadataKeys.SYNTH                              // Synth step configuration
MetadataKeys.SYNTH_CODE_BUILD_DEFAULTS          // Synth CodeBuild defaults

// ── CodeBuild Step Configuration ──
MetadataKeys.ACTION_ROLE                        // Custom action role
MetadataKeys.ADDITIONAL_INPUTS                  // Additional input artifacts
MetadataKeys.BUILD_ENVIRONMENT                  // Build environment config
MetadataKeys.CACHE                              // Build cache configuration
MetadataKeys.COMMANDS                           // Build commands
MetadataKeys.CODE_BUILD_ENV                     // Environment variables
MetadataKeys.ENV_FROM_CFN_OUTPUTS               // Environment from CloudFormation outputs
MetadataKeys.FILE_SYSTEM_LOCATIONS              // EFS file system locations
MetadataKeys.INPUT                              // Primary input artifact
MetadataKeys.INSTALL_COMMANDS                   // Install commands
MetadataKeys.LOGGING                            // CloudWatch logging configuration
MetadataKeys.PARTIAL_BUILD_SPEC                 // Partial BuildSpec configuration
MetadataKeys.PRIMARY_OUTPUT_DIRECTORY           // Primary output directory
MetadataKeys.PROJECT_NAME                       // CodeBuild project name
MetadataKeys.STEP_ROLE                          // Custom CodeBuild role
MetadataKeys.ROLE_POLICY_STATEMENTS             // Additional IAM policy statements
MetadataKeys.TIMEOUT                            // Build timeout

// ── ShellStep Configuration ──
MetadataKeys.SHELL_ADDITIONAL_INPUTS            // Additional input artifacts (ShellStep)
MetadataKeys.SHELL_COMMANDS                     // Shell commands
MetadataKeys.SHELL_ENV                          // Environment variables (ShellStep)
MetadataKeys.SHELL_ENV_FROM_CFN_OUTPUTS         // Environment from CFN outputs (ShellStep)
MetadataKeys.SHELL_INPUT                        // Primary input (ShellStep)
MetadataKeys.SHELL_INSTALL_COMMANDS             // Install commands (ShellStep)
MetadataKeys.SHELL_PRIMARY_OUTPUT_DIRECTORY     // Output directory (ShellStep)

// ── Build Environment Configuration ──
MetadataKeys.PRIVILEGED                         // Privileged mode for Docker
MetadataKeys.BUILD_IMAGE                        // Custom build image
MetadataKeys.CERTIFICATE                        // SSL/TLS certificate
MetadataKeys.COMPUTE_TYPE                       // Compute type (SMALL, MEDIUM, LARGE, etc.)
MetadataKeys.DOCKER_SERVER                      // Docker registry server
MetadataKeys.ENVIRONMENT_VARIABLES              // Environment variables map
MetadataKeys.FLEET                              // CodeBuild fleet configuration

// ── Network Configuration ──
MetadataKeys.NETWORK_TYPE                       // Network type
MetadataKeys.NETWORK_VPC_ID                     // VPC ID
MetadataKeys.NETWORK_SUBNET_IDS                 // Subnet IDs
MetadataKeys.NETWORK_SUBNET_TYPE                // Subnet type (PUBLIC, PRIVATE, etc.)
MetadataKeys.NETWORK_AVAILABILITY_ZONES         // Availability zones
MetadataKeys.NETWORK_SUBNET_GROUP_NAME          // Subnet group name
MetadataKeys.NETWORK_SECURITY_GROUP_IDS         // Security group IDs
MetadataKeys.NETWORK_TAGS                       // Network resource tags
MetadataKeys.NETWORK_VPC_NAME                   // VPC name
MetadataKeys.NETWORK_REGION                     // Network region

// ── IAM Role Configuration ──
MetadataKeys.ROLE_TYPE                          // Role type (ARN, NAME, etc.)
MetadataKeys.ROLE_ARN                           // IAM role ARN
MetadataKeys.ROLE_NAME                          // IAM role name
MetadataKeys.ROLE_MUTABLE                       // Role mutability flag

// ── Security Group Configuration ──
MetadataKeys.SECURITY_GROUP_TYPE                // Security group type
MetadataKeys.SECURITY_GROUP_IDS                 // Security group IDs
MetadataKeys.SECURITY_GROUP_MUTABLE             // Security group mutability
MetadataKeys.SECURITY_GROUP_NAME                // Security group name
MetadataKeys.SECURITY_GROUP_VPC_ID              // VPC ID for security group

// ── Custom Build Configuration ──
MetadataKeys.BUILD_PARALLEL                     // Enable parallel builds
MetadataKeys.BUILD_CACHE                        // Build cache settings
MetadataKeys.BUILD_TIMEOUT                      // Build timeout override
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

**Built with ❤️ using AWS CDK, TypeScript, and Infrastructure as Code Best Practices**
