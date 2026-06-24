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

## Container Packaging

The **PackageImage** stage (`docker-build`) builds a container image from the
repository **source** (the `Dockerfile` and build context come from the repo,
not from a prior stage). To avoid rebuilding the app inside the image, the
compiled output from **BuildAndPackage** (`rust`) is attached as an
additional input and mounted at **`build-artifact/`**.

Your `Dockerfile` should `COPY` the compiled release binary from that mount instead of recompiling:

```dockerfile
# build-artifact/ holds the BuildAndPackage output; the repo is the build context
COPY build-artifact/target/release/<binary> /usr/local/bin/app
```

> The mount path mirrors the producer's output layout (`rust`). Adjust the
> `COPY` source to match your project's actual artifact path.
