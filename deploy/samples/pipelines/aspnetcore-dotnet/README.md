# ASP.NET Core Pipeline

**Repository:** [Azure-Samples/dotnetcore-docs-hello-world](https://github.com/Azure-Samples/dotnetcore-docs-hello-world)
**Language:** C# / .NET
**Build Tool:** dotnet CLI

## Overview

A CI/CD pipeline for a minimal ASP.NET Core (net10.0) hello-world web app. It builds
the application on .NET and then runs a set of security scans — a compact starting
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
| **BuildAndPackage** | `dotnet` | Compile and package the application |
| **SecurityScan** | `dotnet-security-scan`, `trivy`, `git-secrets` | Security scanning (SAST, dependencies, secrets) |

## Pipeline Flow

```
Source -> Synth -> BuildAndPackage -> SecurityScan
```

## Key Configuration

- **.NET 10.0** build via the `dotnet` plugin (default version `1.0.0`), running as a
  **`pre`** step with a **30-minute** timeout
- **LARGE compute** (15 GB / 8 vCPU) for the build stage
- **SecurityScan** runs `dotnet-security-scan` (`pre`) and `trivy` (`pre`) with
  `TRIVY_SEVERITY=HIGH,CRITICAL`, followed by `git-secrets` (`post`)
- All security scans use `failureBehavior: warn` (findings are surfaced but do not
  fail the pipeline)
- Source trigger is **`NONE`** (deploy/run the pipeline manually rather than on push)

## Extending This Pipeline

This sample intentionally ships with just a build and a security-scan stage. Common
next steps:

- **Tests + coverage** — add a stage with a `dotnet-test` plugin
- **Code quality** — `dotnet-format` and Roslyn analyzers for style and static analysis
- **Container image** — a `docker-build` stage that packages the compiled artifact
