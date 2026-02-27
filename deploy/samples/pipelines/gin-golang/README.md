# Gin Go Pipeline

**Repository:** [gin-gonic/gin](https://github.com/gin-gonic/gin)
**Language:** Go
**Build Tool:** go build

## Overview

A comprehensive CI/CD pipeline for Gin, the fastest Go HTTP framework. Includes Go-native static analysis, race condition detection, performance benchmarking, container image building, and security scanning with Go-specific tools.

## Stages

| Stage | Plugins | Purpose |
|-------|---------|---------|
| **Static-Analysis** | golangci-lint, go-vet, govulncheck | Comprehensive linting, vet checks, and vulnerability detection |
| **Test** | go-test, go-test-race | Unit tests with coverage and race condition detection |
| **Benchmark** | go-bench | Performance benchmarking with memory allocation tracking |
| **Build** | go-build, docker-build | Static binary compilation and container image creation |
| **Security** | trivy, gosec | Filesystem scanning and Go-specific security analysis |

## Pipeline Flow

```
Source (GitHub) → Synth → Static-Analysis → Test → Benchmark → Build → Security
```

## Key Configuration

- **Go 1.22** across all stages
- **Race detector** enabled for thorough concurrency testing
- **CGO disabled** for fully static Linux/amd64 binary
- **golangci-lint** for comprehensive Go linting (replaces individual linters)
- **govulncheck** for Go module vulnerability scanning
- **gosec** for Go-specific security issues (SQL injection, crypto, etc.)
- **Benchmark stage** uses MEDIUM compute for consistent results
- **Docker privileged mode** enabled for container build stage
