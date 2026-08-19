# Spring Boot Java Pipeline

**Repository:** [dstar55/docker-hello-world-spring-boot](https://github.com/dstar55/docker-hello-world-spring-boot)
**Language:** Java
**Build Tool:** Maven

## Overview

A CI/CD pipeline for a minimal Spring Boot (Java/Maven) hello-world app. It builds
and packages the application on Amazon Corretto — a compact starting point you can
extend with test, quality, security, and container-packaging stages.

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
| **BuildAndPackage** | `java-corretto` | Compile and package the application |

## Pipeline Flow

```
Source -> Synth -> BuildAndPackage
```

## Key Configuration

- **Amazon Corretto** build via the `java-corretto` plugin (default version `1.0.0`)
- Runs as a **`pre`** step with a **30-minute** timeout
- Source trigger is **`NONE`** (deploy/run the pipeline manually rather than on push)

## Extending This Pipeline

This sample intentionally ships with a single build stage. Common next steps:

- **Tests + coverage** — add a stage with a JaCoCo (or Surefire) plugin
- **Code quality** — Checkstyle / SpotBugs
- **Security scanning** — Semgrep (SAST) and OWASP Dependency-Check
- **Container image** — a `docker-build` stage that packages the compiled artifact
  (the repo already includes a `Dockerfile`)
