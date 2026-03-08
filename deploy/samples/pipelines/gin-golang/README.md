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
