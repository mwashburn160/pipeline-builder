# Gin Go Pipeline

**Repository:** [gin-gonic/gin](https://github.com/gin-gonic/gin)
**Language:** Go
**Build Tool:** go build

## Overview

A comprehensive CI/CD pipeline for Gin, the fastest Go HTTP framework. Includes Go-native static analysis, testing, container image building, and security scanning with Go-specific tools.

## Stages

| Stage | Plugins | Purpose |
|-------|---------|---------|
| **Static-Analysis** | golangci-lint, govulncheck | Comprehensive linting and vulnerability detection |
| **Test** | go-test | Unit tests with coverage |
| **Build** | go-compile, docker-build | Static binary compilation and container image creation |
| **Security** | trivy, gosec | Filesystem scanning and Go-specific security analysis |

## Pipeline Flow

```
Source (GitHub) → Synth → Static-Analysis → Test → Build → Security
```

## Key Configuration

- **Go 1.22** across all stages
- **CGO disabled** for fully static Linux/amd64 binary
- **golangci-lint** for comprehensive Go linting (replaces individual linters)
- **govulncheck** for Go module vulnerability scanning
- **gosec** for Go-specific security issues (SQL injection, crypto, etc.)
- **Docker privileged mode** enabled for container build stage
