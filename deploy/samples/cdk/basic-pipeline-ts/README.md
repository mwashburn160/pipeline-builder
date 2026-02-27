# Basic Pipeline (TypeScript)

## Overview

The simplest possible `PipelineBuilder` usage in TypeScript. Creates a self-mutating CDK pipeline sourced from GitHub with four stages: Lint, Test, Build, and Security.

## What This Example Shows

- How to instantiate `PipelineBuilder` inside a CDK `Stack`
- Configuring a GitHub source with auto-trigger
- Defining `global` metadata for pipeline-wide CDK settings
- Creating multiple stages with `pre` and `post` positioned steps
- Using `filter` on plugin references for version and access control
- Setting per-step `timeout`, `failureBehavior`, and `commands`
- Overriding compute type via `aws:cdk:codebuild:buildenvironment:computetype`

## Key Imports

```typescript
import { PipelineBuilder, BuilderProps } from '@mwashburn160/pipeline-core';
```

## Pipeline Structure

```
GitHub (acmecorp/my-web-app)
  → Synth (cdk-synth)
    → Lint (eslint + prettier)
      → Test (jest)
        → Build (nodejs-build, MEDIUM compute)
          → Security (snyk + git-secrets)
```

## Usage

```typescript
const app = new cdk.App();
new BasicPipelineStack(app, 'BasicPipeline', {
  env: { account: '111111111111', region: 'us-east-1' },
});
```
