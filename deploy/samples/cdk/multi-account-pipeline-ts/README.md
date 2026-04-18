# Multi-Account Pipeline (TypeScript)

## Overview

Enterprise multi-account deployment pipeline with a staging → approval → production flow across three separate AWS accounts. Demonstrates cross-account KMS keys, IAM role configuration, CodeStar connection, ManualApprovalStep gates, and a reusable helper function for creating deploy stages.

## What This Example Shows

- Configuring cross-account KMS encryption with automatic key rotation
- Setting pipeline-level IAM `role` via `roleArn` with `mutable: false`
- Using a CodeStar connection with `codeBuildCloneOutput: true` for full git clone
- Creating a `ManualApprovalStep` gate between staging and production
- Using a TypeScript helper function (`createDeployStage`) to reduce stage boilerplate
- Plugin aliasing for deploy and health-check steps across environments
- Tenant-scoped secrets via `orgId`

## Key Imports

```typescript
import {
  PipelineBuilder,
  BuilderProps,
  RoleConfig,
  StageOptions,
} from '@mwashburn160/pipeline-core';
```

## Account Flow

```
Tooling (111...)              Staging (222...)         Production (333...)
┌──────────────┐              ┌──────────────┐         ┌──────────────┐
│ CodePipeline │──── deploy ─▶│ CloudFormation│         │ CloudFormation│
│ CodeBuild    │              │ Health Check  │         │ Health Check  │
│ KMS Keys     │              └──────────────┘         └──────────────┘
│              │                                              ▲
│              │──── approval gate ── deploy ─────────────────┘
└──────────────┘
```

## Usage

```typescript
const app = new cdk.App();
new MultiAccountPipelineStack(app, 'MultiAccountPipeline', {
  env: { account: '111111111111', region: 'us-east-1' },
});
```
