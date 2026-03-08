# Axum Rust Pipeline

**Repository:** [tokio-rs/axum](https://github.com/tokio-rs/axum)
**Language:** Rust
**Build Tool:** Cargo

## Overview

A CI/CD pipeline for Axum, the ergonomic Rust web framework built on Tokio. Includes building with Docker containerization, testing, Clippy linting, dependency auditing, and crates.io publishing.

## Stages

| Stage | Plugins | Purpose |
|-------|---------|---------|
| **Build** | cargo-release, docker-build | Release binary compilation and container packaging |
| **Test** | cargo-test | Workspace test execution |
| **Lint** | clippy, rustfmt | Lint warnings and formatting checks |
| **Security** | cargo-audit, git-secrets | Dependency audit and secret detection |
| **Publish** | cargo-publish | Dry-run publish to crates.io |

## Pipeline Flow

```
Source (GitHub) → Synth → Build → Test → Lint → Security → Publish
```

## Key Configuration

- **Stable Rust** for primary builds, **nightly** for rustfmt
- **Clippy** with `-D warnings` to treat all warnings as errors
- **cargo-audit** for known vulnerability scanning in dependency tree
- **MEDIUM compute** (7 GB / 4 vCPU) for compilation-heavy stages
- **Release profile** for optimized binary output
