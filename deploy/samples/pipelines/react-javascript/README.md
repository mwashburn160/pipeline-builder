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

## Container Packaging

The **PackageImage** stage (`docker-build`) builds a container image from the
repository **source** (the `Dockerfile` and build context come from the repo,
not from a prior stage). To avoid rebuilding the app inside the image, the
compiled output from **BuildAndPackage** (`nodejs-bundle`) is attached as an
additional input and mounted at **`build-artifact/`**.

Your `Dockerfile` should `COPY` the production bundle (contents of build-output/) from that mount instead of recompiling:

```dockerfile
# build-artifact/ holds the BuildAndPackage output; the repo is the build context
COPY build-artifact/ /usr/share/nginx/html/
```

> The mount path mirrors the producer's output layout (`nodejs-bundle`). Adjust the
> `COPY` source to match your project's actual artifact path.
