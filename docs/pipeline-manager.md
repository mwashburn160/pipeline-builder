---
layout: default
title: Pipeline Manager (CLI)
---

# Pipeline Manager (CLI)

`pipeline-manager` is the command-line interface for Pipeline Builder. It does two jobs:

1. **Installs the platform itself** — stand up Pipeline Builder on Docker Compose, Minikube, EC2, or EKS (Auto Mode) with the `infra provision` command.
2. **Manages pipelines and plugins** against a running platform — bootstrap a CDK project, synth, deploy, register pipelines, browse the plugin catalog, and run operator audits.

The CLI talks to the platform's REST API for resource operations and drives AWS CDK / CloudFormation for deploys.

## Overview

`pipeline-manager` is the command-line interface for Pipeline Builder, serving both operators who install the platform and developers who manage pipelines against a running one. It talks to the platform's REST API for resource operations and drives AWS CDK / CloudFormation for deploys. This page covers installation, the [`infra provision`](#installing-the-platform-infra-provision) installer, the full [command reference](#command-reference), [configuration](#configuration) precedence, and [typical workflows](#typical-workflows).

## Process overview

Two flows, depending on the job:

**Install the platform**

1. `npm install -g @pipeline-builder/pipeline-manager`.
2. `infra provision --target <docker|minikube|ec2|eks>` — prereq checks, plan, gated deploy, health verify, and post-install loads.
3. Tear down later with `infra provision --teardown`.

**Build and ship a pipeline**

1. `auth login` against your platform.
2. `infra bootstrap` a CDK project, then `pipeline synth`.
3. `pipeline deploy` to AWS (auto-registers the pipeline); check `status`, and run `audit stacks` / `audit tokens` on a schedule to catch drift.

---

## Install

```bash
npm install -g @pipeline-builder/pipeline-manager
```

Requires **Node.js 24.14.0+**. The binary is exposed as `pipeline-manager`.

```bash
pipeline-manager --help            # global help
pipeline-manager <command> --help  # full flag reference for any command
pipeline-manager version           # CLI version info
```

### Prerequisites for local pipeline deploys

`pipeline synth` / `pipeline deploy` (and running `cdk deploy` directly) synthesize
the pipeline stack, which bundles the **PluginLookup Lambda** via CDK's
`NodejsFunction` (esbuild). `pipeline synth`/`deploy` **preflight this for you** —
they check `esbuild` + `pnpm` are on `PATH` and fail fast with the fix below rather
than letting the build die deep in an opaque bundling error. (Bypass the check with
`SKIP_BUNDLER_CHECK=1`.) If **esbuild** isn't on `PATH`, CDK silently falls back
to **Docker bundling**, which can't resolve the handler's `axios` / `../config`
imports and fails with:

```
esbuild cannot run locally. Switching to Docker bundling
✘ [ERROR] Could not resolve "axios"
✘ [ERROR] Could not resolve "../config/handler-constants.js"
```

Install esbuild **and** pnpm (the handler's lockfile is `pnpm-lock.yaml`, so CDK
uses pnpm to run esbuild) — plus the CDK CLI — globally, matching the versions the
CodeBuild bootstrap image bakes in:

```bash
npm install -g esbuild@0.28.1 pnpm@10.33.0 aws-cdk@2.1126.0
```

With esbuild on `PATH`, `NodejsFunction` bundles **locally** (no Docker) and the
Lambda resolves correctly. In CodeBuild this is handled for you — the bootstrap
image ships these tools (see
[AWS deployment → CodeBuild bootstrap image](aws-deployment.md#build-the-codebuild-bootstrap-image-build-codebuild-bootstrapsh)).

---

## Quick start

```bash
# Authenticate against your Pipeline Builder platform
pipeline-manager auth login --url https://platform.example.com

# Bootstrap a new pipeline project in the current directory
pipeline-manager infra bootstrap

# Synthesize the CDK app into a CloudFormation template
pipeline-manager pipeline synth

# Deploy the pipeline to AWS (also registers it with the platform)
pipeline-manager pipeline deploy
```

---

## Installing the platform (`infra provision`)

`infra provision` is the recommended way to stand up the **platform** (not a pipeline). It runs prerequisite checks, assembles the exact `bin/setup.sh` command (secrets masked, missing inputs reported — never guessed), shows the plan, and **deploys it end-to-end, gated by confirmation prompts**.

```bash
# Deploy local — show the plan, confirm, deploy, verify /health + /ready, init-platform:
pipeline-manager infra provision --target docker

# Inspect the plan as JSON, run nothing (the only non-executing mode):
pipeline-manager infra provision --target docker --json

# Deploy to EKS Auto Mode (add --yes for non-interactive CI):
pipeline-manager infra provision --target eks \
  --domain pipeline.example.com --hosted-zone-id Z123 --ghcr-token ghp_xxx --email

# Tear it down (AWS targets prompt you to TYPE the cluster/target id to confirm):
pipeline-manager infra provision --target eks --teardown

# Bootstrap a fresh machine — sparse-clone only the deploy folders this target needs,
# then deploy + register the admin:
pipeline-manager infra provision --target docker --repo --yes \
  --admin-email admin@acme.com --admin-password 's3cret'

# Add post-install loads (each also adds its folder to the sparse clone):
pipeline-manager infra provision --target docker --repo --with-all --with-smoke-test
```

### What `infra provision` handles

- **Deploy (gated) or teardown.** It shows the plan, then deploys — refusing on failed prerequisites or missing inputs, confirming before it runs (`--yes` auto-accepts for CI), then verifying health and running `init-platform`. `--json` prints the plan and runs nothing. `--teardown` removes a deployment: `local`/`minikube` stop the stack; **EC2 deletes its CloudFormation stack and EKS runs `bin/shutdown.sh` (cluster + EFS + ACM + Route 53), both irreversibly** and require typing the stack/cluster id to confirm (`--force` skips it for CI).
- **Prerequisites, handled.** The checks mirror each target's `setup.sh` exactly — local: Docker, Docker Compose, `yq`, `openssl`; minikube: Docker, minikube, kubectl, `openssl` (+ `yq` with `--with-plugins`); ec2: AWS CLI + working credentials; eks: AWS CLI + credentials, `kubectl`, `openssl`, `envsubst` (+ `yq` with `--with-plugins`). `eksctl` is auto-installed by `setup.sh` when not on PATH. Missing **single-binary** tools (`yq`, `kubectl`, `minikube`) are offered as an on-demand **fetch** into `~/.pipeline-manager/tools` and put on PATH — no `brew`/`apt`, no system change. For local/minikube it also **creates the target's `.env`** from `.env.example`, generating the `CHANGE_ME` secrets.
- **Self-healing.** On a failed deploy it matches known CloudFormation issues (cause + fix) and can auto-fix + retry a few — e.g. an existing SES identity → re-run with `--skip-ses-identity`. Gated and bounded by `--retries` (the scripts are idempotent, so a re-run resumes).
- **AI-optional.** Set `ANTHROPIC_API_KEY` (or `AI_PROVIDER` + its key) to parse a natural-language `--prompt` and add free-form failure diagnosis; without a key it falls back to the deterministic issue matcher.
- **Bootstrap a fresh machine (`--repo`).** Without a checkout, `--repo` git-clones the platform repo first, then runs from it. The clone is **sparse + partial** (`--filter=blob:none` + cone `sparse-checkout`, git ≥ 2.27 — else a full-clone fallback): it materializes only the deploy folders the selected target + options need. Re-syncs are **additive** — a single `--workdir` can accumulate multiple targets. Override with `--repo <url>`, `--ref <branch|tag>`, `--workdir <dir>`.
- **Run in Docker, zero host installs.** [`deploy/bin/provision-docker.sh`](../deploy/bin/provision-docker.sh) runs `infra provision` inside a throwaway `node:24-slim` container, installing only the tools the chosen target needs. Args pass straight through. (On macOS the container can't drive Docker Desktop's CLI, so run **local** on the host instead — the wrapper shines for the AWS targets.)
- **Post-install steps.** After deploy + health, `infra provision` registers the admin (non-interactive with `--admin-email`/`--admin-password`) and runs opt-in loads — passed as flags or **offered interactively after the clone** when none are given: `--with-plugins` (adds `deploy/plugins` + `deploy/codebuild`), `--with-compliance`, `--with-samples`, `--with-all`, `--with-smoke-test`, **`--with-events`** (AWS event ingestion: `infra store-token` writes a platform JWT to Secrets Manager, then `infra setup-events` deploys the EventBridge → SQS → Lambda), and repeatable `--post-step "<cmd>"`. Default is register-only; `--init skip` skips even that. All steps are idempotent.

The underlying `bin/setup.sh` / `bin/shutdown.sh` scripts (and `aws cloudformation delete-stack` for ec2) remain the source of truth and can always be run directly. Full guide: [AWS deployment → AI-assisted install](aws-deployment.md#ai-assisted-install-infra-provision).

---

## Command reference

Run `pipeline-manager <command> --help` for the full flag reference on any command.

### Platform installation

| Command | Purpose |
| --- | --- |
| `infra provision` | Install (or tear down) the **platform** on local/Minikube/EC2/EKS: prereq checks + assembles the exact `bin/setup.sh` command, then **deploys it** (gated by confirmation; `--yes` for CI, `--json` to print the plan and run nothing), verifying health + running post-install steps. `--repo` bootstraps a fresh machine via a sparse clone; `--with-*`/`--post-step` add post-install steps; `--teardown` removes it. On failure it diagnoses + auto-fixes/retries known issues. |

### Project lifecycle

| Command | Purpose |
| --- | --- |
| `infra bootstrap` | Scaffold a new pipeline project with `cdk.json` and starter config |
| `pipeline synth` | Run CDK synth to emit the CloudFormation template for the pipeline |
| `pipeline deploy` | Deploy the synthesized pipeline stack to AWS (also registers the pipeline with the platform by its `pipelineId`) |
| `pipeline register` | Re-register a deployed pipeline and drain pending intents queued by prior failed deploys (recovery path; exits non-zero if any registration still fails) |
| `status` | Report the current deployment and execution status |

### Resource management

| Command | Purpose |
| --- | --- |
| `pipeline create` | Register a new pipeline definition with the platform |
| `pipeline list` / `pipeline get` | Inspect pipelines registered to your organization |
| `plugin list` / `plugin get` | Browse the plugin catalog and fetch a single plugin spec |
| `plugin new` | Scaffold a local plugin directory (`config.yaml`, `plugin-spec.yaml`, starter `Dockerfile`) ready to edit and upload |
| `plugin upload` | Publish a custom plugin spec + Dockerfile to the platform |
| `plugin validate` | Validate a local plugin directory (spec + config + `{{ ... }}` templates) before upload — exits non-zero on any problem (CI-friendly) |
| `template validate` | Parse and validate `{{ ... }}` templates in a pipeline or plugin spec (local file, registered pipeline by ID, or registered plugin by `name:version`) |
| `org export` | Export an organization's data as JSON for GDPR portability (sysadmins can export any org; org admins their own only) |

### Auth & infrastructure

| Command | Purpose |
| --- | --- |
| `auth login` | Authenticate against the platform and persist the access token (supports `--refresh <token>` and `--org <orgId>` to switch organizations) |
| `infra store-token` | Generate a long-lived JWT and store it in AWS Secrets Manager (used by the events Lambda and CodePipeline synth steps). Add `--schedule` to also deploy a daily auto-renewal stack so the token never lapses |
| `infra setup-events` | Deploy the EventBridge → SQS → Lambda stack that streams CodePipeline events into the platform's reporting service |

### Operator audits (cron-friendly)

These commands report drift and **exit non-zero when findings exist** — designed to run on a schedule.

| Command | Purpose | Exit codes |
| --- | --- | --- |
| `audit stacks` | Diff CloudFormation stacks tagged `pipeline-builder` against the platform's `pipeline_registry`. Surfaces orphaned stacks (no DB row) and missing stacks (DB row, no live stack). See [drift detection](aws-deployment.md#drift-detection-audit-stacks). | `0` clean / `1` findings / `2` AWS error |
| `audit tokens` | Scan platform tokens in AWS Secrets Manager and flag any expiring within `--warn-days` (default 7). Run before tokens lapse to avoid silent reporting outages. | `0` clean / `1` at-risk / `2` AWS error |

### Misc

| Command | Purpose |
| --- | --- |
| `completions` | Print a shell completion script for `bash`, `zsh`, or `fish`. Source it from your shell profile, e.g. `eval "$(pipeline-manager completions bash)"` in `~/.bashrc` (derived from the live command list, so they never drift) |
| `version` | Print CLI version info |

---

## Configuration

The CLI resolves its settings from three layers, lowest to highest precedence:

1. **Built-in defaults**
2. **User config file** — `~/.pipeline-manager/config.yml`
3. **Project config file** — `CLI_CONFIG_PATH`, else `./config.yml`

Environment variables override the resolved config. `auth login` persists your access token to the user config so subsequent commands authenticate automatically.

### Environment variables

| Variable | Required | Purpose |
| --- | --- | --- |
| `PLATFORM_TOKEN` | Yes (for API ops) | Auth token for the Pipeline Builder platform |
| `PLATFORM_BASE_URL` | Yes (for API ops) | Base URL of your platform deployment |
| `AWS_REGION` | Yes (for deploy) | Target AWS region for `pipeline synth` / `pipeline deploy` / `infra provision` teardown |
| `CLI_CONFIG_PATH` | No | Override the project config file path (default `./config.yml`) |
| `UPLOAD_TIMEOUT` | No | Override the plugin-upload request timeout (ms) |
| `SKIP_BUNDLER_CHECK` | No | Set to `1` to skip the `esbuild` + `pnpm` preflight before `pipeline synth`/`deploy` (see [local deploy prerequisites](#prerequisites-for-local-pipeline-deploys)) |
| `TLS_REJECT_UNAUTHORIZED` | No | Set to `0` to skip TLS verification (ignored in `NODE_ENV=production`) |
| `ANTHROPIC_API_KEY` (or other provider key) | No | Enables `infra provision`'s natural-language `--prompt` parsing + failure diagnosis |
| `AI_PROVIDER` / `AI_MODEL` | No | Provider + model for `infra provision` (`anthropic` \| `openai` \| `google` \| `xai` \| `bedrock`) |

Full reference: [Environment Variables](environment-variables.md).

---

## Typical workflows

### Stand up a platform and load everything

```bash
pipeline-manager infra provision --target eks --repo \
  --domain pipeline.example.com --hosted-zone-id Z123 --ghcr-token ghp_xxx \
  --email --admin-email admin@acme.com --admin-password 's3cret' \
  --with-all --with-events --yes
```

### Build and ship a pipeline

```bash
pipeline-manager auth login --url https://platform.example.com
pipeline-manager infra bootstrap
pipeline-manager pipeline synth
pipeline-manager pipeline deploy
pipeline-manager status
```

### Schedule drift detection (cron)

```bash
# Non-zero exit on findings makes these CI/cron friendly
pipeline-manager audit stacks   || alert "stack drift detected"
pipeline-manager audit tokens --warn-days 14 || alert "tokens expiring soon"
```

---

## Related documentation

- [AWS Deployment](aws-deployment.md) — EC2/EKS deploy, post-deploy setup, drift detection
- [CDK Usage](cdk-usage.md) — the `PipelineBuilder` construct used by bootstrapped projects
- [API Reference](api-reference.md) — REST endpoints the CLI calls
- [Template Syntax](templates.md) — `{{ ... }}` interpolation validated by `template validate`
- [Environment Variables](environment-variables.md) — full configuration reference
