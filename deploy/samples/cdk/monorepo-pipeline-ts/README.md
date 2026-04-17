# Monorepo Pipeline (TypeScript)

## Overview

Demonstrates building and deploying multiple services from a single pnpm workspace monorepo. Uses TypeScript helper functions to reduce boilerplate, CodeStar with full git clone for cross-package dependencies, and per-service Docker container packaging.

## What This Example Shows

- TypeScript factory functions (`createNodeStep`, `createDockerStep`) for reusable step definitions
- CodeStar source with `codeBuildCloneOutput: true` for full monorepo git clone
- `preInstallCommands` to install workspace tools (pnpm) before plugin commands
- `preCommands` / `postCommands` for directory navigation within monorepo
- Per-step `env` variables (`SERVICE_NAME`, `WORKDIR`)
- Plugin aliasing to use the same plugin across multiple services (`build-frontend`, `build-api`, etc.)
- Multi-image Trivy scanning in a single step
- Pipeline-level `MEDIUM` compute default for all services

## Key Imports

```typescript
import {
  PipelineBuilder,
  BuilderProps,
  StageStepOptions,
} from '@pipeline-builder/pipeline-core';
```

## Monorepo Structure

```
platform-monorepo/
├── packages/
│   ├── frontend/        ← React SPA
│   │   ├── Dockerfile
│   │   └── package.json
│   ├── api/             ← Express API
│   │   ├── Dockerfile
│   │   └── package.json
│   └── worker/          ← Background processor
│       ├── Dockerfile
│       └── package.json
├── pnpm-workspace.yaml
└── cdk/                 ← CDK infrastructure
```

## Pipeline Flow

```
Source (CodeStar, full clone)
  → Synth (cdk-synth + pnpm install)
    → Lint (eslint + typecheck, all packages)
      → Build-Services (frontend + api + worker, parallel)
        → Package (3x docker-build, parallel)
          → Security (snyk-nodejs all-projects + trivy-nodejs 3 images)
            → Deploy (cdk deploy --all)
```

## Usage

```typescript
const app = new cdk.App();
new MonorepoPipelineStack(app, 'MonorepoPipeline', {
  env: { account: '111111111111', region: 'us-east-1' },
});
```
