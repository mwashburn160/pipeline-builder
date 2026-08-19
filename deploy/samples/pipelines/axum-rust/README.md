# Axum Rust Pipeline

**Repository:** [ChiefTechDev/Rust-Axum-Hello-World](https://github.com/ChiefTechDev/Rust-Axum-Hello-World)
**Language:** Rust
**Build Tool:** Cargo

## Overview

A CI/CD pipeline for a minimal Axum (Rust) hello-world web app. It builds the
application with Cargo and then runs security scanning — a compact starting point
you can extend with test, quality, and container-packaging stages.

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
| **BuildAndPackage** | `rust` | Compile and package the application |
| **SecurityScan** | `cargo-audit`, `git-secrets` | Audit dependencies for known vulnerabilities and scan for committed secrets |

## Pipeline Flow

```
Source -> Synth -> BuildAndPackage -> SecurityScan
```

## Key Configuration

- **Stable Rust** build via the `rust` plugin (`RUST_VERSION=stable`, default version `1.0.0`)
- Build runs as a **`pre`** step with a **30-minute** timeout on **MEDIUM compute**
- **cargo-audit** (`pre`) scans the dependency tree for known vulnerabilities
- **git-secrets** (`post`) scans for committed secrets
- Both security steps use `failureBehavior: warn` (findings are surfaced but don't fail the pipeline)
- Source trigger is **`NONE`** (deploy/run the pipeline manually rather than on push)

## Extending This Pipeline

This sample intentionally ships with a build stage and a security stage. Common
next steps not yet present:

- **Tests + coverage** — add a stage with a `cargo-test` plugin
- **Code quality** — Clippy linting and `rustfmt` formatting checks
- **Container image** — a `docker-build` stage that packages the compiled binary
