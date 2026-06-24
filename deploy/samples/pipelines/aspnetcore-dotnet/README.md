# ASP.NET Core Pipeline

**Repository:** [dotnet/aspnetcore](https://github.com/dotnet/aspnetcore)
**Language:** C# / .NET
**Build Tool:** dotnet CLI / MSBuild

## Overview

A CI/CD pipeline for ASP.NET Core, Microsoft's cross-platform web framework. Includes building with Docker containerization, testing, code analysis, security scanning, and NuGet publishing.

## Stages

| Stage | Plugins | Purpose |
|-------|---------|---------|
| **Build** | dotnet-test, docker-build | Compile .NET solution and build Docker image |
| **Test** | dotnet-test | Run test suite with code coverage |
| **Lint** | dotnet-format, roslyn-analyzers | Code formatting and static analysis |
| **Security** | dotnet-security-scan, trivy-dotnet, git-secrets | .NET security scanning, filesystem analysis, secret detection |
| **Publish** | nuget-publish | Pack and push NuGet packages |

## Pipeline Flow

```
Source (GitHub) → Synth → Build → Test → Lint → Security → Publish
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
