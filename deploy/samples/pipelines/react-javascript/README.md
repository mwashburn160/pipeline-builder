# React JavaScript Pipeline

**Repository:** [facebook/react](https://github.com/facebook/react)
**Language:** JavaScript / TypeScript
**Build Tool:** Yarn

## Overview

A comprehensive CI/CD pipeline for React, Meta's declarative UI library. This pipeline covers the full lifecycle from code quality checks through testing, building, security scanning, and package publishing.

## Stages

| Stage | Plugins | Purpose |
|-------|---------|---------|
| **Lint** | eslint, prettier | Code style and formatting enforcement |
| **Unit-Test** | jest | Test execution with coverage |
| **Build** | nodejs-bundle, typescript-check | Production build and type checking |
| **Security** | git-secrets, npm-audit | Secret detection and dependency scanning |
| **Package** | npm-publish | Publish packages to npm registry |

## Pipeline Flow

```
Source (GitHub) → Synth → Lint → Unit-Test → Build → Security → Package
```

## Key Configuration

- **Node.js 20** across all stages
- **Yarn** with frozen lockfile for reproducible installs
- **Jest** with 80% coverage threshold
- **npm audit** runs with `warn` failure behavior to avoid blocking on advisory-only vulnerabilities
- **Auto-trigger** on pushes to `main` branch
