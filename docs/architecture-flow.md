---
layout: default
title: Architecture Flow
---

# Pipeline Builder - Architecture Flow

## Overview

Pipeline Builder is a multi-team platform for creating AWS CodePipeline CI/CD pipelines using reusable, containerized plugins. Users define pipelines through the UI/API, and the system synthesizes them into CloudFormation templates via AWS CDK. It ships with 119 ready-to-use plugins spanning build, test, security, quality, monitoring, and infrastructure, and can also generate new plugins and pipelines from natural-language prompts via pluggable AI providers (Anthropic, OpenAI, Amazon Bedrock).

---

## System Architecture

```mermaid
flowchart TB
    subgraph Clients
        FE[Frontend<br/>Next.js]
        CLI[CLI<br/>pipeline-manager]
        API_EXT[REST API]
    end

    subgraph Platform["Pipeline Builder Platform"]
        NGINX[Nginx<br/>Reverse Proxy]
        PLATFORM[Platform API<br/>Auth / Gateway]
        PIPELINE[Pipeline API]
        PLUGIN[Plugin API]
        COMPLIANCE[Compliance]
        QUOTA[Quota]
        BILLING[Billing]
        MESSAGE[Message]
        REPORTING[Reporting]
        IMGREG[Image Registry<br/>Token / Image API]
    end

    subgraph Data
        MONGO[(MongoDB<br/>Users / Orgs)]
        PG[(PostgreSQL<br/>Pipelines / Plugins)]
        REDIS[(Redis<br/>BullMQ / Cache)]
    end

    subgraph Build
        BK[buildkitd Sidecar<br/>Rootless BuildKit]
        REG[Registry<br/>Plugin Images]
    end

    FE & CLI & API_EXT --> NGINX
    NGINX --> PLATFORM
    PLATFORM --> PIPELINE & PLUGIN & COMPLIANCE & QUOTA & BILLING & MESSAGE & REPORTING & IMGREG
    PLUGIN & PIPELINE -->|validate| COMPLIANCE
    PLATFORM --> MONGO
    PIPELINE & PLUGIN & COMPLIANCE & REPORTING --> PG
    PLUGIN --> REDIS
    PLUGIN -->|buildctl build_image| BK
    PLUGIN -->|crane push prebuilt| REG
    BK -->|push with scoped Bearer token| REG
    IMGREG -->|mint scoped token| REG
```

---

## Flow 1: Plugin Upload & Build

Plugins are containerized build tools (e.g., `eslint`, `terraform`, `docker-build`) packaged as ZIP files containing a Dockerfile and plugin-spec.yaml.

```mermaid
sequenceDiagram
    participant Dev as Developer
    participant API as Plugin API
    participant Queue as Build Queue<br/>(BullMQ)
    participant BK as buildkitd Sidecar
    participant Reg as Registry
    participant DB as PostgreSQL

    Dev->>API: POST /plugins (multipart: plugin.zip)
    API->>API: Extract ZIP (spec, Dockerfile, config)
    API->>API: Compliance check (fail-closed)
    API-->>Dev: 202 Accepted

    API->>Queue: Enqueue build job

    Queue->>BK: buildctl build --frontend dockerfile.v0
    BK->>Reg: push (bearer-token auth)
    Queue->>DB: Store plugin (name, version, commands, env)
    Queue-->>Dev: SSE: build complete
```

### Plugin ZIP Structure

```mermaid
flowchart LR
    ZIP[plugin.zip] --> Config[config.yaml<br/>buildType, dockerfile path]
    ZIP --> Spec[plugin-spec.yaml<br/>name, version, commands, env]
    ZIP --> DF[Dockerfile<br/>Container image]
    ZIP --> TAR[image.tar<br/>prebuilt only]
```

### Build Types

```mermaid
flowchart LR
    subgraph build_image
        DF2[Dockerfile] --> Build[buildctl build] --> Push1[buildkit push] --> R1[Registry]
    end

    subgraph prebuilt
        TAR2[image.tar] --> Push2[crane push] --> R2[Registry]
    end

    subgraph metadata_only
        Spec2[plugin-spec.yaml] --> Direct[Deploy directly<br/>No Docker build]
    end
```

---

## Flow 2: Pipeline Creation

Users compose pipelines from plugins via the UI or API.

```mermaid
sequenceDiagram
    participant User as User (UI/API)
    participant Plat as Platform API
    participant Pipe as Pipeline API
    participant Comp as Compliance
    participant DB as PostgreSQL

    User->>Plat: Create Pipeline (project, org, props)
    Plat->>Pipe: POST /pipelines
    Pipe->>Pipe: Auth + quota check
    Pipe->>Comp: Validate pipeline props
    Comp-->>Pipe: Allowed / Blocked
    Pipe->>DB: Store pipeline (id, project, org, props JSON)
    Pipe-->>User: 201 Created
```

### BuilderProps Structure (stored as JSON in `props` column)

```json
{
  "project": "my-app",
  "organization": "acme-corp",
  "pipelineName": "main-pipeline",
  "synth": {
    "source": { "repo": "owner/repo", "branch": "main" },
    "plugin": { "name": "cdk-synth" }
  },
  "stages": [
    {
      "stageName": "Test",
      "steps": [
        { "plugin": { "name": "jest" } },
        { "plugin": { "name": "eslint" } }
      ]
    },
    {
      "stageName": "Security",
      "steps": [
        { "plugin": { "name": "snyk-nodejs" } },
        { "plugin": { "name": "trivy" } }
      ]
    },
    {
      "stageName": "Deploy",
      "steps": [
        { "plugin": { "name": "cdk-deploy" } }
      ]
    }
  ]
}
```

---

## Flow 3: CDK Synthesis (Pipeline to CloudFormation)

The pipeline definition is synthesized into an AWS CloudFormation template using CDK.

```mermaid
sequenceDiagram
    participant CLI as pipeline-manager
    participant CDK as CDK Constructs
    participant Lambda as Plugin Lookup<br/>Lambda
    participant API as Platform API

    CLI->>CDK: cdk synth / cdk deploy
    CDK->>CDK: PipelineBuilder(props)
    CDK->>CDK: Create PluginLookup (Custom Resource + Lambda)

    Note over CDK,Lambda: At deploy time (CloudFormation)
    CDK->>Lambda: Resolve stage plugins
    Lambda->>API: POST /api/plugins/lookup
    API-->>Lambda: Plugin config (commands, env, computeType)
    Lambda-->>CDK: Base64-encoded plugin data

    CDK->>CDK: Create CodeBuildStep per stage/step
    CDK->>CDK: Assemble CodePipeline (Source → Synth → Stages)
    CDK-->>CLI: CloudFormation template
```

### Generated CloudFormation Resources

```mermaid
flowchart TB
    CFN[CloudFormation Template]
    CFN --> CP[AWS::CodePipeline::Pipeline]
    CFN --> CB1[AWS::CodeBuild::Project x N]
    CFN --> LF[AWS::Lambda::Function<br/>Plugin Lookup]
    CFN --> IAM[AWS::IAM::Role<br/>Pipeline Execution]
    CFN --> S3[AWS::S3::Bucket<br/>Artifacts]
    CFN --> CW[AWS::CloudWatch::LogGroup]

    CB1 --> BE[BuildEnvironment]
    BE --> IMG[Image: plugin or AWS default]
    BE --> CT[ComputeType: from plugin]
    BE --> ENV[EnvironmentVariables:<br/>plugin.env + metadata + secrets]
```

---

## Flow 4: CodePipeline Execution

When the generated pipeline runs (triggered by source change, schedule, or manual start).

```mermaid
sequenceDiagram
    participant GH as GitHub
    participant CP as CodePipeline
    participant CB as CodeBuild
    participant IMG as Plugin Image

    GH->>CP: Push / webhook
    CP->>CP: Stage: Source (fetch code)

    CP->>CB: Stage: Synth
    CB->>IMG: Pull cdk-synth image
    CB->>CB: Run pipeline-manager synth
    CB-->>CP: Output: cdk.out/

    CP->>CP: Stage: SelfMutation (update pipeline if changed)

    CP->>CB: Stage: Test
    CB->>IMG: Pull jest + eslint images
    CB->>CB: Run plugin commands

    CP->>CB: Stage: Security
    CB->>IMG: Pull snyk + trivy images
    CB->>CB: Run security scans

    CP->>CB: Stage: Deploy
    CB->>IMG: Pull cdk-deploy image
    CB->>CB: Run deployment

    CP->>CP: Pipeline Complete
```

### How Plugin Images Are Used at Runtime

```mermaid
flowchart LR
    subgraph Database
        Plugin[Plugin Record<br/>name: eslint<br/>version: 1.0.0<br/>commands: npx eslint .<br/>computeType: SMALL]
    end

    subgraph "CDK Synth Time"
        CBS[CodeBuildStep<br/>Image: registry/org-acme/eslint:1.0.0<br/>ComputeType: BUILD_GENERAL1_SMALL<br/>BuildSpec: npx eslint .]
    end

    subgraph "CodePipeline Runtime"
        CB2[CodeBuild pulls image<br/>Runs install + build commands<br/>In plugin container]
    end

    Plugin --> CBS --> CB2
```

---

## Key Components

| Component | Purpose | Key Files |
|-----------|---------|-----------|
| **Frontend** | Pipeline/plugin management UI | `frontend/pages/dashboard/` |
| **Platform API** | Auth gateway, user/org management | `platform/src/controllers/` |
| **Pipeline API** | Pipeline CRUD, compliance | `api/pipeline/src/` |
| **Plugin API** | Plugin upload, build queue, AI generation | `api/plugin/src/` |
| **Image Registry** | Registry bearer-token minting, image management/GC | `api/image-registry/src/` |
| **pipeline-core** | CDK constructs, plugin lookup | `packages/pipeline-core/src/pipeline/` |
| **pipeline-data** | DB schemas (Drizzle ORM) | `packages/pipeline-data/src/database/` |
| **pipeline-manager** | CLI for cdk synth/deploy | `packages/pipeline-manager/` |
| **buildkitd sidecar** | Rootless BuildKit daemon for plugin builds | K8s native sidecar / ECS sidecar / compose service |
| **Registry** | Docker image storage | Docker Registry v2 |

---

## Multi-Team Isolation

```mermaid
flowchart TB
    ORG[Organization: acme-corp<br/>orgId: abc123]
    ORG --> PLUG[Plugins<br/>scoped by orgId + accessModifier]
    ORG --> PIPE[Pipelines<br/>scoped by project, org, orgId]
    ORG --> SEC[Secrets<br/>AWS SM: /prefix/abc123/secretName]
    ORG --> QUO[Quotas<br/>per-org limits]
    ORG --> COMP[Compliance<br/>per-org policy rules]
```
