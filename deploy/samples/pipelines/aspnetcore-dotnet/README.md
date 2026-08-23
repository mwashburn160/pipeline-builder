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
repositories** (there is no anonymous GitHub source). If the token secret is
missing, the deploy fails at pipeline-creation time with:

> Secrets Manager can't find the specified secret. (ResourceNotFoundException)

This sample resolves the secret **per org** using [synth-time templating](../../../../docs/templates.md):
the source `token` references `secretsmanager:pipeline-builder/{{ pipeline.vars.orgId }}/github-token`,
following the house naming standard `pipeline-builder/{orgId}/{name}`.

**1. Set your org id.** Replace the placeholder in the `vars` block of
[`pipeline.json`](pipeline.json) with your organization's ID (the UUID, not the
display name):

```json
"vars": { "orgId": "1234abcd-…-your-org-id" }
```

**2. Create the token secret** at the matching path, once per account/region:

```bash
aws secretsmanager create-secret \
  --name "pipeline-builder/<orgId>/github-token" \
  --secret-string "ghp_YOUR_TOKEN_HERE" \
  --region <your-region>
```

Use a GitHub personal access token with `repo` + `admin:repo_hook` scopes (for a
public repo, `public_repo` + `admin:repo_hook` is sufficient). `<orgId>` must match
the `vars.orgId` you set in step 1 — at synth the token resolves to
`secretsmanager:pipeline-builder/<orgId>/github-token`.

> **Simpler alternative:** drop the `token` line and the `vars` block, and instead
> create a bare secret named `github-token` — CDK's default lookup. **Recommended
> alternative:** use a **CodeStar / CodeConnections** source (`"type": "codestar"`
> with a `connectionArn`) — see [docs/cdk-usage.md](../../../../docs/cdk-usage.md) —
> which avoids storing a PAT entirely.

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

- **.NET** build via the `dotnet` plugin (plugin version `1.0.0`; the .NET SDK is
  pinned by the plugin's base image), running as a **`pre`** step with a
  **30-minute** timeout
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
