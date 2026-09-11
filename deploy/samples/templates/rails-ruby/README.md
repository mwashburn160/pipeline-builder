# Rails Ruby Template

**Repository:** [m9rc1n/hello-world-rails](https://github.com/m9rc1n/hello-world-rails)
**Language:** Ruby
**Build Tool:** Bundler / Rails

## Overview

A golden-path template for a minimal Rails (Ruby) hello-world app. The pipeline it
produces runs Brakeman SAST, a bundler dependency audit, and secret detection — a
compact starting point you can extend with build, test, quality, and
container-packaging stages.

## Prerequisites

This template uses a **GitHub (v1/OAuth) source**. AWS CodePipeline authenticates
that source with an OAuth token stored in AWS Secrets Manager — **even for public
repositories** (there is no anonymous GitHub source). If the token secret is
missing, the deploy fails at pipeline-creation time with:

> Secrets Manager can't find the specified secret. (ResourceNotFoundException)

The template resolves the secret **per org** using [synth-time templating](../../../../docs/templates.md):
the source `token` references `secretsmanager:pipeline-builder/{{ pipeline.vars.orgId }}/github-token`,
following the house naming standard `pipeline-builder/{orgId}/{name}`.

`orgId` is the template's one **declared input** — you supply it when you
instantiate, and it lands in the generated pipeline's `props.vars.orgId`. Nothing
in the template body needs editing.

**Create the token secret** at the matching path, once per account/region:

```bash
aws secretsmanager create-secret \
  --name "pipeline-builder/<orgId>/github-token" \
  --secret-string "ghp_YOUR_TOKEN_HERE" \
  --region <your-region>
```

Use a GitHub personal access token with `repo` + `admin:repo_hook` scopes (for a
public repo, `public_repo` + `admin:repo_hook` is sufficient). `<orgId>` must match
the `orgId` input you pass at instantiate time — at synth the token resolves to
`secretsmanager:pipeline-builder/<orgId>/github-token`.

> **Simpler alternative:** drop the `token` line from `props.synth.source.options`
> and instead create a bare secret named `github-token` — CDK's default lookup.
> **Recommended alternative:** use a **CodeStar / CodeConnections** source
> (`"type": "codestar"` with a `connectionArn`) — see
> [docs/cdk-usage.md](../../../../docs/cdk-usage.md) — which avoids storing a PAT
> entirely.

## Using This Template

Templates are not pipelines — they are parameterized starting points. Instantiate
one into concrete pipeline `props`, then create the pipeline from those props (the
normal create path, so compliance and quota still apply):

```bash
# 1. Render the template into concrete pipeline props (creates nothing)
pipeline-manager template instantiate \
  --name rails-ruby \
  --project rails --organization AcmeCorp \
  --input orgId=<your-org-id> \
  --output pipeline-props.json

# 2. Create (and optionally deploy) the pipeline from those props
pipeline-manager pipeline create --file pipeline-props.json --deploy --region us-east-1
```

Or pick the template from the dashboard's golden-path catalog and fill in the
inputs there.

## Stages

| Stage | Plugins | Purpose |
|-------|---------|---------|
| **SecurityScan** | `brakeman`, `bundler-audit`, `git-secrets` | Rails SAST, gem advisory audit, and secret scanning |

## Pipeline Flow

```
Source -> Synth -> SecurityScan
```

## Key Configuration

- **`brakeman`** and **`bundler-audit`** run as **`pre`** steps with **`warn`**
  failure behavior (findings do not block the pipeline)
- **`git-secrets`** runs as a **`post`** step, also with **`warn`** failure behavior
- Source trigger is **`NONE`** (deploy/run the pipeline manually rather than on push)

## Extending This Template

This template intentionally ships with a single security stage. Common next steps —
edit `props.stages` in your own copy, or in the generated props:

- **Build + dependencies** — `bundle install` and `rails assets:precompile`
- **Tests + coverage** — RSpec (or Minitest) with SimpleCov thresholds
- **Code quality** — RuboCop
- **Container image** — a `docker-build` stage that packages the app behind Puma
