# Gin Go Pipeline

**Repository:** [gin-gonic/gin](https://github.com/gin-gonic/gin)
**Language:** Go
**Build Tool:** go build

## Overview

A CI/CD pipeline for Gin, the fastest Go HTTP framework. Includes building with Docker containerization, testing, linting, and Go-native security scanning.

## Stages

| Stage | Plugins | Purpose |
|-------|---------|---------|
| **Build** | go-compile, docker-build | Static binary compilation and container image creation |
| **Test** | go-test | Unit tests with coverage |
| **Lint** | golangci-lint | Comprehensive Go linting |
| **Security** | govulncheck, gosec, git-secrets | Vulnerability detection, SAST, and secret detection |

## Pipeline Flow

```
Source (GitHub) → Synth → Build → Test → Lint → Security
```

## Key Configuration

- **Go 1.22** across all stages
- **CGO disabled** for fully static Linux/amd64 binary
- **golangci-lint** for comprehensive Go linting (replaces individual linters)
- **govulncheck** for Go module vulnerability scanning
- **gosec** for Go-specific security issues
- **Docker privileged mode** enabled for container build

## Container Packaging

The **PackageImage** stage (`docker-build`) builds a container image from the
repository **source** (the `Dockerfile` and build context come from the repo,
not from a prior stage). To avoid rebuilding the app inside the image, the
compiled output from **BuildAndPackage** (`go-compile`) is attached as an
additional input and mounted at **`build-artifact/`**.

Your `Dockerfile` should `COPY` the compiled Go binary (contents of bin/) from that mount instead of recompiling:

```dockerfile
# build-artifact/ holds the BuildAndPackage output; the repo is the build context
COPY build-artifact/<binary> /usr/local/bin/app
```

> The mount path mirrors the producer's output layout (`go-compile`). Adjust the
> `COPY` source to match your project's actual artifact path.
