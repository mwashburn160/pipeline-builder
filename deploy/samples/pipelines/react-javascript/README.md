# React JavaScript Pipeline

**Repository:** [facebook/react](https://github.com/facebook/react)
**Language:** JavaScript / TypeScript
**Build Tool:** Yarn

## Overview

A CI/CD pipeline for React, Meta's declarative UI library. Covers building, testing, linting, security scanning, and package publishing.

## Stages

| Stage | Plugins | Purpose |
|-------|---------|---------|
| **Build** | nodejs-bundle, typescript-check | Production build and type checking |
| **Test** | jest | Unit test execution |
| **Lint** | eslint, prettier | Code style and formatting enforcement |
| **Security** | npm-audit, git-secrets | Dependency scanning and secret detection |
| **Publish** | npm-publish | Publish packages to npm registry |

## Pipeline Flow

```
Source (GitHub) → Synth → Build → Test → Lint → Security → Publish
```

## Key Configuration

- **Node.js 20** across all stages
- **Yarn** with frozen lockfile for reproducible installs
- **npm audit** runs with `warn` failure behavior to avoid blocking on advisory-only vulnerabilities
- **Auto-trigger** on pushes to `main` branch
