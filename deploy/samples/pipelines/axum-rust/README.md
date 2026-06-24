# Axum Rust Pipeline

**Repository:** [tokio-rs/axum](https://github.com/tokio-rs/axum)
**Language:** Rust
**Build Tool:** Cargo

## Overview

A CI/CD pipeline for Axum, the ergonomic Rust web framework built on Tokio. Includes building with Docker containerization, testing, Clippy linting, dependency auditing, and crates.io publishing.

## Stages

| Stage | Plugins | Purpose |
|-------|---------|---------|
| **BuildAndPackage** | `rust` | Compile and package the application |
| **UnitTests** | `cargo-test` | Run the test suite |
| **CodeQuality** | `clippy`, `rustfmt` | Code style enforcement and static analysis |
| **SecurityScan** | `cargo-audit`, `git-secrets` | Security scanning (SAST, dependencies, secrets) |
| **PackageImage** | `docker-build` | Build the container image (repo source + BuildAndPackage artifact) |

## Pipeline Flow

```
Source -> Synth -> BuildAndPackage -> UnitTests -> CodeQuality -> SecurityScan -> PackageImage
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
