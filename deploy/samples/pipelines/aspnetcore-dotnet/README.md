# ASP.NET Core Pipeline

**Repository:** [dotnet/aspnetcore](https://github.com/dotnet/aspnetcore)
**Language:** C# / .NET
**Build Tool:** dotnet CLI / MSBuild

## Overview

A CI/CD pipeline for ASP.NET Core, Microsoft's cross-platform web framework. Includes building with Docker containerization, testing, code analysis, security scanning, and NuGet publishing.

## Stages

| Stage | Plugins | Purpose |
|-------|---------|---------|
| **BuildAndPackage** | `dotnet` | Compile and package the application |
| **UnitTests** | `dotnet-test` | Run the test suite |
| **CodeQuality** | `dotnet-format`, `roslyn-analyzers` | Code style enforcement and static analysis |
| **SecurityScan** | `dotnet-security-scan`, `trivy`, `git-secrets` | Security scanning (SAST, dependencies, secrets) |
| **PackageImage** | `docker-build` | Build the container image (repo source + BuildAndPackage artifact) |

## Pipeline Flow

```
Source -> Synth -> BuildAndPackage -> UnitTests -> CodeQuality -> SecurityScan -> PackageImage
```

## Key Configuration

- **.NET 8.0** as primary SDK
- **LARGE compute** (15 GB / 8 vCPU) for build and test stages
- **Roslyn analyzers** with `TreatWarningsAsErrors` for strict code quality
- **dotnet-format** for enforcing consistent code style
- **Docker privileged mode** enabled for container build

## Container Packaging

The **PackageImage** stage (`docker-build`) builds a container image from the
repository **source** (the `Dockerfile` and build context come from the repo,
not from a prior stage). To avoid rebuilding the app inside the image, the
compiled output from **BuildAndPackage** (`dotnet`) is attached as an
additional input and mounted at **`build-artifact/`**.

Your `Dockerfile` should `COPY` the published .NET output from that mount instead of recompiling:

```dockerfile
# build-artifact/ holds the BuildAndPackage output; the repo is the build context
COPY build-artifact/ ./app/
```

> The mount path mirrors the producer's output layout (`dotnet`). Adjust the
> `COPY` source to match your project's actual artifact path.
