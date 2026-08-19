# Gin Go Pipeline

**Repository:** [lamhotsimamora/Hello-World-Golang-Gin](https://github.com/lamhotsimamora/Hello-World-Golang-Gin)
**Language:** Go
**Build Tool:** go build

## Overview

A CI/CD pipeline for a minimal Gin (Go) hello-world web app. It compiles the
application and then runs a set of Go-native security scans — a compact starting
point you can extend with test, quality, and container-packaging stages.

## Prerequisites

This pipeline uses a **GitHub (v1/OAuth) source**. AWS CodePipeline authenticates
that source with an OAuth token stored in AWS Secrets Manager — **even for public
repositories** (there is no anonymous GitHub source). When the source options omit
an explicit `token`, CDK looks up a secret named **`github-token`** by default.

If that secret does not exist, the deploy fails at pipeline-creation time with:

> Secrets Manager can't find the specified secret. (ResourceNotFoundException)

Create it once per account/region before deploying:

```bash
aws secretsmanager create-secret \
  --name github-token \
  --secret-string "ghp_YOUR_TOKEN_HERE" \
  --region <your-region>
```

Use a GitHub personal access token with `repo` + `admin:repo_hook` scopes (for a
public repo, `public_repo` + `admin:repo_hook` is sufficient).

> **Alternative (recommended):** use a **CodeStar / CodeConnections** source
> (`"type": "codestar"` with a `connectionArn`) instead of a PAT — see
> [docs/cdk-usage.md](../../../../docs/cdk-usage.md). It avoids storing a token and
> is AWS's modern GitHub integration.

## Stages

| Stage | Plugins | Purpose |
|-------|---------|---------|
| **BuildAndPackage** | `go-compile` | Compile the application into a static Linux binary |
| **SecurityScan** | `govulncheck`, `gosec`, `git-secrets` | Security scanning (module vulnerabilities, SAST, secrets) |

## Pipeline Flow

```
Source -> Synth -> BuildAndPackage -> SecurityScan
```

## Key Configuration

- **Go 1.24.13** for both build and security stages
- **CGO disabled** (`CGO_ENABLED=0`) for a fully static **linux/amd64** binary
- **govulncheck** for Go module vulnerability scanning
- **gosec** for Go-specific static security analysis
- **git-secrets** to catch committed credentials (runs as a **`post`** step)
- All **SecurityScan** plugins use `failureBehavior: warn` (findings report but do not fail the pipeline)
- Source trigger is **`NONE`** (deploy/run the pipeline manually rather than on push)

## Extending This Pipeline

This sample intentionally ships with a build stage plus security scans. Common next steps:

- **Tests + coverage** — add a stage with a `go-test` plugin
- **Code quality** — `golangci-lint` for linting and static analysis
- **Container image** — a `docker-build` stage that packages the compiled binary
