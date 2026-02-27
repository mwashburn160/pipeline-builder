# Axum Rust Pipeline

**Repository:** [tokio-rs/axum](https://github.com/tokio-rs/axum)
**Language:** Rust
**Build Tool:** Cargo

## Overview

A thorough CI/CD pipeline for Axum, the ergonomic Rust web framework built on Tokio. Includes Clippy linting, multi-toolchain testing (stable + MSRV), Miri memory safety verification, dependency auditing, and crates.io publishing.

## Stages

| Stage | Plugins | Purpose |
|-------|---------|---------|
| **Lint** | clippy, rustfmt, cargo-doc | Lint warnings, formatting, and documentation checks |
| **Test** | cargo-test (x2) | Workspace tests on stable and MSRV (1.75.0) |
| **Safety** | cargo-miri, cargo-audit | Undefined behavior detection and dependency audit |
| **Build** | cargo-build, docker-build | Release binary compilation and container packaging |
| **Publish** | cargo-publish | Dry-run publish to crates.io |

## Pipeline Flow

```
Source (GitHub) → Synth → Lint → Test → Safety → Build → Publish
```

## Key Configuration

- **Stable Rust** for primary builds, **nightly** for rustfmt and Miri
- **MSRV testing** at Rust 1.75.0 to verify minimum supported version
- **Clippy** with `-D warnings` to treat all warnings as errors
- **Miri** for detecting undefined behavior in unsafe code (advisory mode)
- **cargo-audit** for known vulnerability scanning in dependency tree
- **MEDIUM compute** (7 GB / 4 vCPU) for compilation-heavy stages
- **Release profile** for optimized binary output
