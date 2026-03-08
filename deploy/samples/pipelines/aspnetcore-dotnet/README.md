# ASP.NET Core Pipeline

**Repository:** [dotnet/aspnetcore](https://github.com/dotnet/aspnetcore)
**Language:** C# / .NET
**Build Tool:** dotnet CLI / MSBuild

## Overview

An enterprise CI/CD pipeline for ASP.NET Core, Microsoft's cross-platform web framework. Features Roslyn code analysis, multi-TFM testing (.NET 8 + 9), container image building with security scanning, and NuGet package publishing.

## Stages

| Stage | Plugins | Purpose |
|-------|---------|---------|
| **Analysis** | dotnet-format, roslyn-analyzers | Code formatting and static analysis |
| **Build-Test** | dotnet-test (x2) | Build + test on .NET 8 (primary) and .NET 9 (compat) |
| **Security** | dotnet-security-scan, trivy | .NET security scanning and filesystem vulnerability analysis |
| **Container** | docker-build | Docker image creation |
| **Publish** | nuget-publish | Pack and push NuGet packages |

## Pipeline Flow

```
Source (GitHub) → Synth → Analysis → Build-Test → Security → Container → Publish
```

## Key Configuration

- **.NET 8.0** as primary SDK, with **.NET 9.0** forward-compatibility testing
- **LARGE compute** (15 GB / 8 vCPU) for the main build stage due to solution size
- **Roslyn analyzers** with `TreatWarningsAsErrors` for strict code quality
- **dotnet-format** for enforcing consistent code style
- **Dual security scanning**: .NET-specific analysis and Trivy filesystem scanning
- **Docker privileged mode** enabled for container build stage
