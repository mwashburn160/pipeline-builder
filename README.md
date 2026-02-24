# Pipeline Builder

**An AWS CDK Construct Library for building CodePipeline infrastructure as code.**

Pipeline Builder is a type-safe, plugin-based construct library that simplifies the creation of AWS CodePipelines using AWS CDK. Define your CI/CD pipelines with a fluent TypeScript API, leverage reusable build plugins, and deploy CodePipeline infrastructure using standard CDK workflows. Optional supporting services provide configuration storage, management, and AI-assisted generation.

[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D24.9.0-brightgreen.svg)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9.3-blue.svg)](https://www.typescriptlang.org)
[![AWS CDK](https://img.shields.io/badge/AWS%20CDK-2.237.0-orange.svg)](https://aws.amazon.com/cdk)

## Table of Contents

- [Overview](#overview)
- [Architecture](#architecture)
- [Getting Started](#getting-started)
- [Working with Plugins](#working-with-plugins)
- [Working with Pipelines](#working-with-pipelines)
- [Deploying Pipelines to AWS](#deploying-pipelines-to-aws)
- [Pipeline Manager CLI](#pipeline-manager-cli)
- [AI-Assisted Generation](#ai-assisted-generation)
- [Frontend Dashboard](#frontend-dashboard)
- [Metadata Keys Reference](#metadata-keys-reference)
- [Package Structure](#package-structure)
- [API Reference](#api-reference)
- [Local Development](#local-development)
- [License](#license)

---

## Overview

Pipeline Builder transforms AWS CodePipeline creation from error-prone CloudFormation templates into type-safe, reusable TypeScript constructs. Build production-ready CI/CD pipelines in minutes with a fluent API that eliminates boilerplate while maintaining full AWS CDK flexibility.

### 100% AWS Construct Solution - Complete Control, Zero Lock-in

**Pipeline Builder is not a SaaS product.** It is a pure Infrastructure-as-Code (IaC) library that generates standard AWS CloudFormation resources.

- **Full Ownership**: Everything runs in your AWS account. No third-party servers, no external dependencies, no data leaving your infrastructure.
- **Native AWS Integration**: Synthesizes directly to CloudFormation templates using AWS CDK. View, debug, and manage all resources through the AWS Console, CLI, or any AWS tooling you already use.
- **Zero Vendor Lock-in**: Generates standard AWS CodePipeline, CodeBuild, and IAM resources. Migrate to raw CDK constructs at any time with zero refactoring.

### Plugin-First Architecture - Build Once, Reuse Everywhere

Stop copying and pasting CodeBuild configurations across repositories. Pipeline Builder's plugin system enables enterprise-scale CI/CD standardization.

- **Instant Updates**: Change a plugin version to roll out improvements across hundreds of pipelines simultaneously
- **Centralized Best Practices**: Encode security policies, compliance requirements, and performance optimizations in plugins that teams automatically inherit
- **Reduced Maintenance**: Fix bugs once in the plugin definition instead of hunting through dozens of pipeline configurations
- **Consistent Environments**: Guarantee all teams use the same build tools, versions, and configurations

### Type-Safe Metadata Engine - Catch Errors Before Deployment

Traditional pipeline configuration fails at runtime. Pipeline Builder fails at **compile time** with full TypeScript IntelliSense.

```typescript
metadata: {
  [MetadataKeys.STEP_ROLE]: customRole.roleArn,          // Type-checked
  [MetadataKeys.COMPUTE_TYPE]: 'BUILD_GENERAL1_LARGE',   // IntelliSense autocomplete
  [MetadataKeys.TIMEOUT]: '60',                          // Validated before synth
  [MetadataKeys.VPC_ID]: 'vpc-12345'                     // Caught at design time
}
```

---

## Architecture

### High-Level Flow

```
                    ┌──────────────────────────────┐
                    │        Ways to Interact       │
                    ├──────────────────────────────┤
                    │  CDK Constructs (direct)      │
                    │  Pipeline Manager CLI         │
                    │  REST APIs                    │
                    │  Frontend Dashboard           │
                    │  AI-Assisted Generation       │
                    └──────────────┬───────────────┘
                                   │
                    ┌──────────────▼───────────────┐
                    │      Plugin Definitions       │
                    │  (reusable build step configs) │
                    └──────────────┬───────────────┘
                                   │
                    ┌──────────────▼───────────────┐
                    │    Pipeline Configurations    │
                    │  (source + stages + plugins)   │
                    └──────────────┬───────────────┘
                                   │
                    ┌──────────────▼───────────────┐
                    │     AWS CDK Constructs        │
                    │      (pipeline-core)          │
                    └──────────────┬───────────────┘
                                   │ cdk deploy
                    ┌──────────────▼───────────────┐
                    │      AWS Infrastructure       │
                    │  CodePipeline · CodeBuild     │
                    │  S3 Artifacts · IAM Roles     │
                    └──────────────────────────────┘
```

### Component Overview

| Component | Purpose | Type |
|-----------|---------|------|
| **pipeline-core** | AWS CDK constructs, plugin system, source builders, metadata management | **Core Library** |
| **pipeline-manager** | CLI tool for managing plugins, pipelines, and deployments | CLI Tool |
| **Pipeline Service** | REST API for pipeline configuration CRUD | Supporting Service |
| **Plugin Service** | REST API for plugin definition CRUD and Docker builds | Supporting Service |
| **Frontend** | Next.js web UI for visual management and AI generation | Supporting Service |
| **Platform Service** | Authentication, organizations, and user management | Supporting Service |

---

## Getting Started

### Prerequisites

- **Node.js** >= 24.9.0
- **AWS CDK** >= 2.237.0
- **AWS Account** with appropriate permissions
- **AWS CLI** configured with credentials

### Installation

```bash
# Install the core construct library
npm install @mwashburn160/pipeline-core

# Or with pnpm
pnpm add @mwashburn160/pipeline-core
```

### Quick Start: CDK Construct

The simplest way to use Pipeline Builder is directly in a CDK stack:

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
      name: 'cdk-synth',
      version: '1.0.0'
    }
  }
});

app.synth();
```

```bash
cdk synth   # Generate CloudFormation template
cdk deploy  # Deploy the pipeline to AWS
```

---

## Working with Plugins

Plugins are reusable build step definitions that encapsulate CI/CD tasks (build commands, install steps, environment variables, compute types). **Create plugins first**, then reference them in pipeline configurations.

### Plugin Lifecycle

```
  Create Plugin               Use in Pipeline            Update / Delete
 ─────────────────    ──────────────────────────    ────────────────────
  ZIP upload (CLI)     Reference by name+version     PUT /plugins/:id
  ZIP upload (API)     in pipeline synth/stages      DELETE /plugins/:id
  AI generation (UI)                                  CLI: list/get
  Inline definition
```

### Option 1: Define Plugins Inline (CDK Only)

For simple cases, define plugins directly in your CDK code:

```typescript
new PipelineBuilder(stack, 'Pipeline', {
  project: 'api',
  organization: 'acme',
  synth: {
    source: {
      type: 'github',
      options: { repo: 'acme/api', branch: 'main' }
    },
    plugin: {
      name: 'node-build',
      version: '1.0.0',
      pluginType: 'CodeBuildStep',
      commands: ['npm ci', 'npm run build'],
      env: { NODE_ENV: 'production' }
    }
  }
});
```

### Option 2: Upload via Pipeline Manager CLI

Package your plugin as a ZIP file containing a `manifest.yaml` and `Dockerfile`, then upload:

```bash
# Upload a plugin ZIP archive
pipeline-manager upload-plugin \
  --file ./my-plugin.zip \
  --organization my-org \
  --name node-build \
  --version 1.0.0 \
  --active

# Validate without uploading
pipeline-manager upload-plugin \
  --file ./my-plugin.zip \
  --organization my-org \
  --dry-run
```

**Required ZIP contents:**
- `manifest.yaml` — Plugin metadata (name, version, pluginType, commands, env, etc.)
- `Dockerfile` — Build environment definition

### Option 3: Upload via REST API

```bash
curl -X POST https://localhost:8443/api/plugins \
  -H "Authorization: Bearer $TOKEN" \
  -H "x-org-id: $ORG_ID" \
  -F "plugin=@./my-plugin.zip" \
  -F "accessModifier=private"
```

### Option 4: AI-Assisted Generation (Frontend or API)

Generate a plugin from a natural language description. See [AI-Assisted Generation](#ai-assisted-generation).

### Listing and Retrieving Plugins

**CLI:**
```bash
# List all plugins (table format by default)
pipeline-manager list-plugins

# Filter by name and version
pipeline-manager list-plugins --name node-build --version 1.0.0

# Filter by access modifier and status
pipeline-manager list-plugins --access-modifier private --is-active true

# Get a single plugin by ID
pipeline-manager get-plugin --id <plugin-id>

# Output as JSON or YAML
pipeline-manager list-plugins --format json
pipeline-manager get-plugin --id <plugin-id> --format yaml --output plugin.yaml
```

**REST API:**
```bash
# List with filtering and pagination
curl "https://localhost:8443/api/plugins?name=node-build&limit=10&sortBy=createdAt&sortOrder=desc" \
  -H "Authorization: Bearer $TOKEN" \
  -H "x-org-id: $ORG_ID"

# Get single plugin by ID
curl "https://localhost:8443/api/plugins/<plugin-id>" \
  -H "Authorization: Bearer $TOKEN" \
  -H "x-org-id: $ORG_ID"

# Find by name and version
curl "https://localhost:8443/api/plugins/find?name=node-build&version=1.0.0" \
  -H "Authorization: Bearer $TOKEN" \
  -H "x-org-id: $ORG_ID"
```

### Updating a Plugin

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

### Deleting a Plugin

```bash
curl -X DELETE "https://localhost:8443/api/plugins/<plugin-id>" \
  -H "Authorization: Bearer $TOKEN" \
  -H "x-org-id: $ORG_ID"
```

---

## Working with Pipelines

Pipelines define the full CI/CD workflow: source repository, synth step, build/test/deploy stages, and metadata. Each stage references plugins for its build steps.

### Pipeline Lifecycle

```
  Create Pipeline              Deploy to AWS              Update / Delete
 ─────────────────    ──────────────────────────    ────────────────────
  CDK construct        CLI: pipeline-manager deploy  PUT /pipelines/:id
  CLI: create-pipeline CDK: cdk deploy               DELETE /pipelines/:id
  REST API                                            CLI: list/get
  AI generation (UI)
```

### Option 1: CDK Construct (Direct)

```typescript
import { PipelineBuilder } from '@mwashburn160/pipeline-core';

new PipelineBuilder(stack, 'MyPipeline', {
  project: 'my-app',
  organization: 'my-org',
  synth: {
    source: {
      type: 'github',
      options: {
        repo: 'my-org/my-app',
        branch: 'main',
        connectionArn: 'arn:aws:codestar-connections:...'
      }
    },
    plugin: { name: 'cdk-synth', version: '1.0.0' }
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
```

### Option 2: Create via Pipeline Manager CLI

Save your pipeline props as a JSON file, then create and deploy:

```bash
# Create a pipeline from a props JSON file
pipeline-manager create-pipeline \
  --file ./pipeline-props.json \
  --project my-app \
  --organization my-org \
  --name my-app-pipeline \
  --access private

# Preview without creating
pipeline-manager create-pipeline \
  --file ./pipeline-props.json \
  --project my-app \
  --organization my-org \
  --dry-run
```

**Example `pipeline-props.json`:**
```json
{
  "project": "my-app",
  "organization": "my-org",
  "synth": {
    "source": {
      "type": "github",
      "options": {
        "repo": "my-org/my-app",
        "branch": "main",
        "connectionArn": "arn:aws:codestar-connections:us-east-1:123456789012:connection/..."
      }
    },
    "plugin": { "name": "cdk-synth", "version": "1.0.0" }
  },
  "stages": [
    {
      "stageName": "Test",
      "steps": [{ "name": "unit-tests", "plugin": { "name": "jest-test", "version": "1.0.0" } }]
    }
  ]
}
```

### Option 3: Create via REST API

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

### Option 4: AI-Assisted Generation (Frontend or API)

Generate pipeline configuration from a natural language description. See [AI-Assisted Generation](#ai-assisted-generation).

### Listing and Retrieving Pipelines

**CLI:**
```bash
# List all pipelines
pipeline-manager list-pipelines

# Filter by project and organization
pipeline-manager list-pipelines --project my-app --organization my-org

# Filter by status
pipeline-manager list-pipelines --is-active true --is-default true

# Get a single pipeline by ID
pipeline-manager get-pipeline --id <pipeline-id>

# Output as JSON, YAML, or CSV
pipeline-manager list-pipelines --format json --output pipelines.json
pipeline-manager get-pipeline --id <pipeline-id> --format yaml
```

**REST API:**
```bash
# List with filtering and pagination
curl "https://localhost:8443/api/pipelines?project=my-app&limit=10&sortBy=createdAt&sortOrder=desc" \
  -H "Authorization: Bearer $TOKEN" \
  -H "x-org-id: $ORG_ID"

# Get single pipeline by ID
curl "https://localhost:8443/api/pipelines/<pipeline-id>" \
  -H "Authorization: Bearer $TOKEN" \
  -H "x-org-id: $ORG_ID"

# Find by project and organization
curl "https://localhost:8443/api/pipelines/find?project=my-app&organization=my-org" \
  -H "Authorization: Bearer $TOKEN" \
  -H "x-org-id: $ORG_ID"
```

### Updating a Pipeline

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

### Deleting a Pipeline

```bash
curl -X DELETE "https://localhost:8443/api/pipelines/<pipeline-id>" \
  -H "Authorization: Bearer $TOKEN" \
  -H "x-org-id: $ORG_ID"
```

---

## Deploying Pipelines to AWS

Once a pipeline configuration exists (created via CLI, API, or UI), deploy it to your AWS account.

### Via Pipeline Manager CLI

```bash
# Deploy a stored pipeline by ID
pipeline-manager deploy --id <pipeline-id>

# Deploy with a specific AWS profile
pipeline-manager deploy --id <pipeline-id> --profile production

# Synth only (generate CloudFormation without deploying)
pipeline-manager deploy --id <pipeline-id> --synth

# Deploy with approval prompt for changes
pipeline-manager deploy --id <pipeline-id> --require-approval any-change
```

The CLI fetches the pipeline configuration from the API, then runs `cdk deploy` against a boilerplate CDK app with your pipeline props.

### Via CDK Directly

If you defined your pipeline as a CDK construct in code:

```bash
cdk synth   # Generate CloudFormation template
cdk deploy  # Deploy to AWS
```

---

## Pipeline Manager CLI

The `pipeline-manager` CLI provides a complete interface for managing plugins, pipelines, and deployments from the terminal.

### Installation

```bash
npm install -g @mwashburn160/pipeline-manager
```

### Authentication

Set your platform token as an environment variable (required for all commands):

```bash
export PLATFORM_TOKEN=<your-jwt-token>
```

Optional environment variables:

| Variable | Description | Default |
|----------|-------------|---------|
| `PLATFORM_BASE_URL` | API base URL | `https://localhost:8443` |
| `CLI_CONFIG_PATH` | Path to YAML config file | `../config.yml` |
| `TLS_REJECT_UNAUTHORIZED` | Set to `0` to skip SSL verification | - |

### Command Reference

| Command | Description |
|---------|-------------|
| `version` | Show CLI version and environment info |
| `list-plugins` | List plugins with filtering, pagination, and sorting |
| `get-plugin --id <id>` | Get a single plugin by ID |
| `upload-plugin --file <zip> --organization <org>` | Upload a plugin ZIP archive |
| `list-pipelines` | List pipelines with filtering, pagination, and sorting |
| `get-pipeline --id <id>` | Get a single pipeline by ID |
| `create-pipeline --file <json>` | Create a pipeline from a props JSON file |
| `deploy --id <id>` | Deploy a pipeline to AWS via CDK |

### Global Flags

| Flag | Description |
|------|-------------|
| `--debug` | Enable debug output with stack traces |
| `--verbose` | Show detailed information |
| `--quiet` | Minimal output (errors only) |
| `--no-color` | Disable colored output |

### Output Formats

All list and get commands support multiple output formats via `--format`:

- `table` — Human-readable ASCII table (default for list commands)
- `json` — JSON output (default for get commands)
- `yaml` — YAML output
- `csv` — CSV output (list commands only)

Save output to a file with `--output <filepath>`.

---

## AI-Assisted Generation

Pipeline Builder includes AI-powered generation for both plugins and pipelines. Describe what you need in plain language and get a complete configuration.

### Supported AI Providers

| Provider | Models |
|----------|--------|
| Anthropic | Claude Sonnet 4, Claude Haiku 4.5 |
| OpenAI | GPT-4o, GPT-4o Mini |
| Google | Gemini 2.0 Flash, Gemini 2.5 Pro |
| xAI | Grok 3, Grok 3 Fast, Grok 3 Mini |
| Amazon Bedrock | Claude 3.5 Sonnet, Nova Pro, Nova Lite |

Providers are available when the corresponding API key is configured on the server.

### AI Pipeline Generation

**Via REST API:**
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

### AI Plugin Generation (Two-Step)

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

### AI Generation via Frontend

The web dashboard provides an **AI Builder** tab in both the Create Pipeline and Create Plugin modals. Select a provider and model, describe your requirements, review the generated configuration, and save — all through the UI.

---

## Frontend Dashboard

The Next.js frontend provides a visual interface for managing the full lifecycle of plugins and pipelines.

### Features

- **Pipeline Management** — Create, view, edit, and delete pipeline configurations
- **Plugin Management** — Upload, view, edit, and delete plugins
- **AI Builder** — Generate pipelines and plugins from natural language prompts
- **Organization Management** — Manage teams, members, and invitations
- **User Settings** — Profile, API tokens, and preferences
- **Activity Logs** — Track operations and changes
- **Dark Mode** — Toggle between light and dark themes

### Dashboard Pages

| Page | Path | Description |
|------|------|-------------|
| Pipelines | `/dashboard/pipelines` | List, create, edit, delete pipeline configurations |
| Plugins | `/dashboard/plugins` | List, upload, edit, delete plugin definitions |
| Organizations | `/dashboard/organizations` | Manage organizations and members |
| Users | `/dashboard/users` | User management (admin) |
| Settings | `/dashboard/settings` | Account settings and preferences |
| Tokens | `/dashboard/tokens` | API token management |
| Logs | `/dashboard/logs` | Activity log viewer |

---

## Metadata Keys Reference

Pipeline Builder provides 50+ strongly-typed metadata keys for configuring every aspect of CodePipeline and CodeBuild resources.

### CodePipeline Configuration

```typescript
MetadataKeys.SELF_MUTATION                      // Enable self-mutation
MetadataKeys.CROSS_ACCOUNT_KEYS                 // Enable cross-account keys
MetadataKeys.DOCKER_ENABLED_FOR_SELF_MUTATION   // Enable Docker for self-mutation
MetadataKeys.DOCKER_ENABLED_FOR_SYNTH           // Enable Docker for synth
MetadataKeys.ENABLE_KEY_ROTATION                // Enable KMS key rotation
MetadataKeys.PUBLISH_ASSETS_IN_PARALLEL         // Parallel asset publishing
MetadataKeys.PIPELINE_ROLE                      // Custom pipeline IAM role
MetadataKeys.PIPELINE_NAME                      // Override pipeline name
MetadataKeys.PIPELINE_TYPE                      // Pipeline type (V1, V2)
MetadataKeys.ARTIFACT_BUCKET                    // Custom artifact bucket
MetadataKeys.CODE_BUILD_DEFAULTS                // CodeBuild defaults for all steps
```

### CodeBuild Step Configuration

```typescript
MetadataKeys.STEP_ROLE                          // Custom CodeBuild role
MetadataKeys.ACTION_ROLE                        // Custom action role
MetadataKeys.BUILD_ENVIRONMENT                  // Build environment config
MetadataKeys.CACHE                              // Build cache configuration
MetadataKeys.COMMANDS                           // Build commands
MetadataKeys.INSTALL_COMMANDS                   // Install commands
MetadataKeys.TIMEOUT                            // Build timeout
MetadataKeys.COMPUTE_TYPE                       // Compute type (SMALL to X2_LARGE)
MetadataKeys.PRIVILEGED                         // Privileged mode for Docker
MetadataKeys.BUILD_IMAGE                        // Custom build image
MetadataKeys.ROLE_POLICY_STATEMENTS             // Additional IAM policy statements
```

### Network Configuration

```typescript
MetadataKeys.NETWORK_VPC_ID                     // VPC ID
MetadataKeys.NETWORK_SUBNET_IDS                 // Subnet IDs
MetadataKeys.NETWORK_SUBNET_TYPE                // Subnet type (PUBLIC, PRIVATE, etc.)
MetadataKeys.NETWORK_SECURITY_GROUP_IDS         // Security group IDs
MetadataKeys.NETWORK_AVAILABILITY_ZONES         // Availability zones
```

### Advanced: Using Metadata with Custom IAM Roles

```typescript
import { PipelineBuilder, MetadataKeys } from '@mwashburn160/pipeline-core';
import { Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam';

const codeBuildRole = new Role(stack, 'CodeBuildRole', {
  assumedBy: new ServicePrincipal('codebuild.amazonaws.com'),
});

new PipelineBuilder(stack, 'Pipeline', {
  project: 'secure-app',
  organization: 'enterprise',
  global: {
    [MetadataKeys.CROSS_ACCOUNT_KEYS]: true,
    [MetadataKeys.DOCKER_ENABLED_FOR_SYNTH]: true,
    [MetadataKeys.SELF_MUTATION]: true,
  },
  synth: {
    source: {
      type: 'github',
      options: { repo: 'enterprise/secure-app', branch: 'main',
        connectionArn: 'arn:aws:codestar-connections:...' }
    },
    plugin: { name: 'build-synth', version: '1.0.0' },
    metadata: {
      [MetadataKeys.STEP_ROLE]: codeBuildRole.roleArn,
      [MetadataKeys.COMPUTE_TYPE]: 'BUILD_GENERAL1_LARGE',
      [MetadataKeys.TIMEOUT]: '60',
    }
  }
});
```

---

## Package Structure

```
pipeline-builder/
├── packages/
│   ├── pipeline-core/       # AWS CDK constructs — the core library
│   ├── pipeline-data/       # Database schemas, ORM, CRUD service layer
│   ├── api-core/            # Core utilities, auth middleware, logging, HTTP client
│   ├── api-server/          # Express server factory, SSE, request context
│   └── pipeline-manager/    # CLI tool for managing plugins, pipelines, deployments
├── api/
│   ├── pipeline/            # Pipeline configuration CRUD + AI generation service
│   └── plugin/              # Plugin definition CRUD + AI generation service
├── platform/                # Authentication, organizations, user management
├── frontend/                # Next.js React dashboard
└── deploy/
    └── local/               # Docker Compose local development environment
```

### Build Order

Packages must be built in dependency order:

1. **api-core** — no internal dependencies
2. **pipeline-data** — depends on api-core
3. **pipeline-core** — depends on api-core + pipeline-data
4. **api-server** — depends on api-core + pipeline-core
5. **All services** — depend on the packages above

---

## API Reference

### Pipeline Service

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

### Plugin Service

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

### Common Query Parameters (List Endpoints)

| Parameter | Type | Description |
|-----------|------|-------------|
| `limit` | integer | Page size (1-100, default: 10) |
| `offset` | integer | Records to skip (default: 0) |
| `sortBy` | string | Field to sort by (default: `createdAt`) |
| `sortOrder` | `asc` / `desc` | Sort direction (default: `desc`) |
| `accessModifier` | `public` / `private` | Filter by visibility |
| `isActive` | boolean | Filter by active status |
| `isDefault` | boolean | Filter by default status |

### Authentication

All API requests require:
- `Authorization: Bearer <JWT>` — JWT token from the Platform service
- `x-org-id: <org-id>` — Organization ID header

---

## Local Development

Run the entire Pipeline Builder platform locally with Docker Compose.

The local development environment includes:
- **All API services** (Platform, Plugin, Pipeline)
- **Database services** (PostgreSQL, MongoDB) with admin interfaces
- **NGINX reverse proxy** with SSL/TLS
- **Frontend application** (Next.js)

```bash
cd deploy/local
docker compose up -d
```

---

## License

This project is licensed under the Apache License 2.0 - see the [LICENSE](LICENSE) file for details.
