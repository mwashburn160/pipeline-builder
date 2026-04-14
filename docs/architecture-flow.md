# Pipeline Builder - Architecture Flow

## Overview

Pipeline Builder is a platform for creating AWS CodePipeline CI/CD pipelines using reusable, containerized plugins. Users define pipelines through the UI/API, and the system synthesizes them into CloudFormation templates via AWS CDK.

---

## System Architecture

```
                                    Pipeline Builder Platform
 +--------------------------------------------------------------------------------------------------+
 |                                                                                                    |
 |   +----------+     +---------+     +----------+     +----------+     +----------+                 |
 |   | Frontend |---->|  Nginx  |---->| Platform |     | Pipeline |     |  Plugin  |                 |
 |   | (Next.js)|     | (Proxy) |     | (Auth/GW)|---->|   API    |     |   API    |                 |
 |   +----------+     +---------+     +----------+     +----------+     +----------+                 |
 |                                         |                |               |    |                    |
 |                                         v                v               v    v                    |
 |                                    +----------+     +----------+    +---------+------+             |
 |                                    | MongoDB  |     |PostgreSQL|    | BullMQ  | dind |             |
 |                                    |(users/org)|    |(pipelines|    | (Redis) |(Docker)            |
 |                                    +----------+     | plugins) |    +---------+------+             |
 |                                                     +----------+         |                         |
 |                                                                          v                         |
 |                                                                    +----------+                    |
 |                                                                    | Registry |                    |
 |                                                                    | (images) |                    |
 |                                                                    +----------+                    |
 +--------------------------------------------------------------------------------------------------+
```

---

## Flow 1: Plugin Upload & Build

Plugins are containerized build tools (e.g., `eslint`, `terraform`, `docker-build`) packaged as ZIP files containing a Dockerfile and plugin-spec.yaml.

```
 Developer                  Plugin API                Build Queue              dind Sidecar         Registry
    |                          |                          |                       |                    |
    |  POST /plugins/upload    |                          |                       |                    |
    |  (plugin.zip)            |                          |                       |                    |
    |------------------------->|                          |                       |                    |
    |                          |                          |                       |                    |
    |                          | 1. Extract ZIP           |                       |                    |
    |                          |    - plugin-spec.yaml    |                       |                    |
    |                          |    - Dockerfile          |                       |                    |
    |                          |    - config.yaml         |                       |                    |
    |                          |                          |                       |                    |
    |                          | 2. Compliance check      |                       |                    |
    |                          |    (fail-closed)         |                       |                    |
    |                          |                          |                       |                    |
    |                          | 3. Enqueue build job     |                       |                    |
    |      202 Accepted        |------------------------->|                       |                    |
    |<-------------------------|                          |                       |                    |
    |                          |                          |                       |                    |
    |                          |                          | 4. docker build       |                    |
    |                          |                          |---------------------->|                    |
    |                          |                          |                       |                    |
    |                          |                          | 5. docker push        |                    |
    |                          |                          |---------------------->|                    |
    |                          |                          |                       |------------------->|
    |                          |                          |                       |                    |
    |                          |                          | 6. Store in DB        |                    |
    |                          |                          |    (PostgreSQL)       |                    |
    |                          |                          |    - name, version    |                    |
    |                          |                          |    - imageTag         |                    |
    |                          |                          |    - commands, env    |                    |
    |                          |                          |    - metadata         |                    |
    |    SSE: build complete   |                          |                       |                    |
    |<-------------------------|<-------------------------|                       |                    |
    |                          |                          |                       |                    |
```

### Plugin ZIP Structure
```
plugin.zip
  +-- config.yaml           # buildType (build_image | prebuilt), dockerfile path
  +-- plugin-spec.yaml      # name, version, commands, env, pluginType, computeType
  +-- Dockerfile            # Container image definition
  +-- image.tar             # (prebuilt only) Pre-built Docker image
```

### Prebuilt vs Build-at-Upload
```
  prebuilt:      ZIP contains image.tar --> docker load --> docker push --> registry
  build_image:   ZIP contains Dockerfile --> docker build --> docker push --> registry
```

---

## Flow 2: Pipeline Creation

Users compose pipelines from plugins via the UI or API.

```
 User (UI/API)            Platform API            Pipeline API           PostgreSQL
    |                        |                        |                      |
    |  Create Pipeline       |                        |                      |
    |  {project, org,        |                        |                      |
    |   props: BuilderProps} |                        |                      |
    |----------------------->|                        |                      |
    |                        |  POST /pipelines       |                      |
    |                        |----------------------->|                      |
    |                        |                        |                      |
    |                        |                        | 1. Auth + quota      |
    |                        |                        |                      |
    |                        |                        | 2. Compliance check  |
    |                        |                        |    (validate props)  |
    |                        |                        |                      |
    |                        |                        | 3. Store pipeline    |
    |                        |                        |--------------------->|
    |                        |                        |                      |
    |                        |                        |   Pipeline record:   |
    |                        |                        |   - id (uuid)        |
    |                        |                        |   - project          |
    |                        |                        |   - organization     |
    |                        |                        |   - props (JSON)     |
    |                        |                        |   - isDefault=true   |
    |                        |                        |                      |
    |      201 Created       |                        |                      |
    |<-----------------------|<-----------------------|                      |
    |                        |                        |                      |
```

### BuilderProps Structure (stored as JSON in `props` column)
```json
{
  "project": "my-app",
  "organization": "acme-corp",
  "pipelineName": "main-pipeline",
  "synth": {
    "source": { "repo": "owner/repo", "branch": "main" },
    "plugin": "nodejs"
  },
  "stages": [
    {
      "name": "Test",
      "steps": [
        { "plugin": "jest", "metadata": {...} },
        { "plugin": "eslint" }
      ]
    },
    {
      "name": "Security",
      "steps": [
        { "plugin": "snyk-nodejs" },
        { "plugin": "trivy-nodejs" }
      ]
    },
    {
      "name": "Deploy",
      "steps": [
        { "plugin": "cdk-deploy", "metadata": {...} }
      ]
    }
  ],
  "defaults": { "computeType": "SMALL" },
  "role": { ... }
}
```

---

## Flow 3: CDK Synthesis (Pipeline to CloudFormation)

The pipeline definition is synthesized into an AWS CloudFormation template using CDK.

```
 pipeline-manager CLI          CDK Constructs              Plugin Lookup Lambda       Platform API
    |                              |                              |                       |
    | cdk synth / cdk deploy       |                              |                       |
    |----------------------------->|                              |                       |
    |                              |                              |                       |
    |                              | 1. PipelineBuilder(props)   |                       |
    |                              |    - Parse BuilderProps      |                       |
    |                              |                              |                       |
    |                              | 2. Create PluginLookup      |                       |
    |                              |    (Custom Resource +       |                       |
    |                              |     Lambda function)        |                       |
    |                              |                              |                       |
    |                              | 3. Resolve synth plugin     |                       |
    |                              |    pluginLookup.plugin()    |                       |
    |                              |         |                    |                       |
    |                              |         | (at deploy time)   |                       |
    |                              |         +------------------->|                       |
    |                              |                              | GET plugin config     |
    |                              |                              |---------------------->|
    |                              |                              |   {name, imageTag,    |
    |                              |                              |    commands, env,     |
    |                              |                              |    computeType, ...}  |
    |                              |                              |<----------------------|
    |                              |                              |                       |
    |                              | 4. Create CodeBuildStep     |                       |
    |                              |    for each stage/step      |                       |
    |                              |    - commands from plugin   |                       |
    |                              |    - env vars from plugin   |                       |
    |                              |    - computeType            |                       |
    |                              |    - secrets (from SM)      |                       |
    |                              |    - buildImage (metadata)  |                       |
    |                              |                              |                       |
    |                              | 5. Assemble CodePipeline   |                       |
    |                              |    Source -> Synth ->       |                       |
    |                              |    [Stages with waves]      |                       |
    |                              |                              |                       |
    |   CloudFormation template    |                              |                       |
    |<-----------------------------|                              |                       |
    |                              |                              |                       |
```

### Generated CloudFormation Resources
```
CloudFormation Template
  +-- AWS::CodePipeline::Pipeline      # The CI/CD pipeline
  +-- AWS::CodeBuild::Project (x N)    # One per pipeline step
  |     +-- BuildEnvironment
  |     |     +-- Image: plugin image or AWS default
  |     |     +-- ComputeType: from plugin.computeType
  |     |     +-- EnvironmentVariables: plugin.env + metadata + secrets
  |     +-- Source: input artifact
  |     +-- BuildSpec: plugin.commands
  |
  +-- AWS::Lambda::Function            # Plugin lookup (custom resource)
  +-- AWS::IAM::Role                   # Pipeline execution role
  +-- AWS::S3::Bucket                  # Artifact storage
  +-- AWS::CloudWatch::LogGroup        # Build logs
```

---

## Flow 4: CodePipeline Execution

When the generated pipeline runs (triggered by source change, schedule, or manual start).

```
 Source (GitHub)        CodePipeline            CodeBuild (per step)         Plugin Image
    |                      |                         |                          |
    | Push / webhook       |                         |                          |
    |--------------------->|                         |                          |
    |                      |                         |                          |
    |                      | Stage: Source            |                          |
    |                      | (fetch code)            |                          |
    |                      |                         |                          |
    |                      | Stage: Synth             |                          |
    |                      |------------------------>|                          |
    |                      |                         | Pull plugin image        |
    |                      |                         |------------------------->|
    |                      |                         |                          |
    |                      |                         | Run plugin.commands:     |
    |                      |                         |   installCommands        |
    |                      |                         |   commands               |
    |                      |                         |   (in plugin container)  |
    |                      |                         |                          |
    |                      |                         | Output: cdk.out/         |
    |                      |                         |                          |
    |                      | Stage: SelfMutation     |                          |
    |                      | (update pipeline if     |                          |
    |                      |  template changed)      |                          |
    |                      |                         |                          |
    |                      | Stage: Test              |                          |
    |                      |------------------------>|                          |
    |                      |                         | jest plugin container    |
    |                      |                         | eslint plugin container  |
    |                      |                         |                          |
    |                      | Stage: Security          |                          |
    |                      |------------------------>|                          |
    |                      |                         | snyk plugin container    |
    |                      |                         | trivy plugin container   |
    |                      |                         |                          |
    |                      | Stage: Deploy            |                          |
    |                      |------------------------>|                          |
    |                      |                         | cdk-deploy container     |
    |                      |                         |                          |
    |                      | Pipeline Complete        |                          |
    |                      |                         |                          |
```

### How Plugin Images Are Used at Runtime
```
Plugin in DB:
  name: "eslint"
  imageTag: "p-eslint-a1b2c3d4e5f6"
  commands: ["npx eslint --format stylish ."]
  installCommands: ["npm ci"]
  computeType: "SMALL"
  env: { NODE_ENV: "test" }

                    |
                    v (at CDK synth time)

CodeBuild Project:
  BuildEnvironment:
    Image: registry:5000/plugin:p-eslint-a1b2c3d4e5f6
    ComputeType: BUILD_GENERAL1_SMALL
    EnvironmentVariables:
      NODE_ENV: "test"
  BuildSpec:
    install:
      commands:
        - npm ci
    build:
      commands:
        - npx eslint --format stylish .
```

---

## Key Components

| Component | Purpose | Key Files |
|-----------|---------|-----------|
| **Frontend** | Pipeline/plugin management UI | `frontend/pages/dashboard/` |
| **Platform API** | Auth gateway, user/org management | `platform/src/controllers/` |
| **Pipeline API** | Pipeline CRUD, compliance | `api/pipeline/src/` |
| **Plugin API** | Plugin upload, build queue | `api/plugin/src/` |
| **pipeline-core** | CDK constructs, plugin lookup | `packages/pipeline-core/src/pipeline/` |
| **pipeline-data** | DB schemas (Drizzle ORM) | `packages/pipeline-data/src/database/` |
| **pipeline-manager** | CLI for cdk synth/deploy | `packages/pipeline-manager/` |
| **dind sidecar** | Docker daemon for plugin builds | K8s sidecar container |
| **Registry** | Docker image storage | Docker Registry v2 |

---

## Multi-Tenant Isolation

```
Organization: acme-corp (orgId: abc123)
  +-- Plugins: scoped by orgId + accessModifier (public/private)
  +-- Pipelines: scoped by (project, organization, orgId)
  +-- Secrets: AWS SM path: /{prefix}/abc123/{secretName}
  +-- Quotas: per-org limits on plugins, pipelines
  +-- Compliance: per-org policy rules
```
