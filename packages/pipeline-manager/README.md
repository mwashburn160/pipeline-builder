# @pipeline-builder/pipeline-manager

📖 **[View documentation](https://mwashburn160.github.io/pipeline-builder/)**

CLI for [Pipeline Builder](https://mwashburn160.github.io/pipeline-builder/): install the platform itself with `provision`, then bootstrap, synth, deploy, and manage CDK pipelines + plugins against it.

## Install

```bash
npm install -g @pipeline-builder/pipeline-manager
```

Requires Node.js 24.14.0+.

## Quick start

```bash
# Authenticate against your Pipeline Builder platform
pipeline-manager login --url https://platform.example.com

# Bootstrap a new project in the current directory
pipeline-manager bootstrap

# Synthesize the CDK app into a CloudFormation template
pipeline-manager synth

# Deploy the pipeline to AWS
pipeline-manager deploy
```

## Install the platform (`provision`)

`provision` is the recommended way to stand up the **platform itself** (not a pipeline) — on Docker Compose, Minikube, EC2, or Fargate. It runs prerequisite checks, assembles the exact `bin/setup.sh` command (secrets masked, missing inputs reported — never guessed), shows the plan, and **deploys it end-to-end, gated by confirmation prompts** (`--yes` for CI; `--json` prints the plan and runs nothing).

```bash
# Deploy local — shows the plan, then confirms (confirm → deploy → /health + /ready → init-platform):
pipeline-manager provision --target local

# Inspect the plan as JSON, run nothing:
pipeline-manager provision --target local --json

# Deploy to Fargate (add --yes for non-interactive CI):
pipeline-manager provision --target fargate \
  --domain pipeline.example.com --hosted-zone-id Z123 --ghcr-token ghp_xxx --email

# Tear it down (AWS targets prompt you to TYPE the target id to confirm):
pipeline-manager provision --target fargate --teardown

# Bootstrap a fresh machine — sparse-clones ONLY the deploy folders this target
# + options need (here: deploy/bin + deploy/local), then deploys + registers:
pipeline-manager provision --target local --repo --yes \
  --admin-email admin@acme.com --admin-password 's3cret'

# Add post-install loads (each also adds its folder to the sparse clone):
pipeline-manager provision --target local --repo --with-all --with-smoke-test
```

- **Deploy (gated) or teardown.** `provision` shows the plan, then deploys — refusing on failed prerequisites or missing inputs, confirming before it runs (`--yes` auto-accepts for CI), then verifying health and running `init-platform`. **`--json`** prints the plan and runs nothing (the only non-executing mode). `--teardown` removes a deployment (`local`/`minikube` stop the stack; **EC2/Fargate delete their CloudFormation stacks irreversibly** and require typing the target id to confirm — `--force` skips it for CI).
- **Prerequisites, handled.** The checks mirror each target's `setup.sh` exactly — local: Docker, Docker Compose, `yq`, `openssl`; minikube: Docker, minikube, kubectl, `openssl` (+ `yq` with `--with-plugins`); ec2/fargate: AWS CLI + working credentials, and fargate adds `openssl`. Missing **single-binary** tools (`yq`, `kubectl`, `minikube`) are offered as an on-demand **fetch** into `~/.pipeline-manager/tools` and put on PATH — no `brew`/`apt`, no system change. For local/minikube it also **creates the target's `.env`** from `.env.example`, generating the `CHANGE_ME` secrets (the same idea as AWS's `init-secrets.sh`). Tools that aren't relocatable binaries (git, Docker/Compose, AWS CLI, openssl) fall back to the normal install instruction, and if you run from outside a checkout it **offers to sparse-clone** the deploy folders for you.
- **Self-healing.** On a failed deploy it matches known CloudFormation issues (cause + fix) and can auto-fix + retry a few — e.g. an existing SES identity → re-run with `--skip-ses-identity`. Gated and bounded by `--retries` (the scripts are idempotent, so a re-run resumes).
- **AI-optional.** Set `ANTHROPIC_API_KEY` (or `AI_PROVIDER` + its key) to parse a natural-language `--prompt` and add free-form failure diagnosis; without a key it falls back to the deterministic issue matcher.
- **Bootstrap a fresh machine (`--repo`).** Without a checkout, `--repo` git-clones the platform repo first, then runs from it. The clone is **sparse + partial** (`--filter=blob:none` + cone `sparse-checkout`, git ≥ 2.27 — else a full-clone fallback): it materializes only the deploy folders the selected target + options need. The common base is just `deploy/bin`; each target adds its own folder (e.g. `deploy/local`; minikube is self-contained), and each post-install load adds its folder. Re-syncs are **additive** — a single `--workdir` can accumulate multiple targets. Override with `--repo <url>`, `--ref <branch|tag>`, `--workdir <dir>`.
- **Run in Docker, zero host installs.** Don't want `git`/`yq`/AWS CLI on your machine? [`deploy/bin/provision-docker.sh`](../../deploy/bin/provision-docker.sh) runs `provision` inside a throwaway `node:24-slim` container, installing only the tools the chosen target needs: **ec2** → git + AWS CLI; **fargate** → + openssl (it mounts `~/.aws` read-only); **local** → git + yq + openssl, with **Docker + Docker Compose used *externally*** from the host via the mounted socket (Docker Desktop already provides them — they're never installed in the image). Host footprint = just Docker. Args pass straight through: `deploy/bin/provision-docker.sh --target fargate --repo --domain … --yes`. (On macOS the container can't drive Docker Desktop's CLI, so run **local** on the host instead — the wrapper shines for the AWS targets.)
- **Post-install steps.** After deploy + health, `provision` registers the admin (non-interactive with `--admin-email`/`--admin-password`) and runs the opt-in loads — passed as flags, or **offered interactively after the clone** when none are given (each picked load is then fetched via an additive sparse re-sync): `--with-plugins` (adds `deploy/plugins` + `deploy/codebuild`), `--with-compliance` (`deploy/compliance`), `--with-samples` (`deploy/samples`), or `--with-all`. Plus `--with-smoke-test` (read-only API check), **`--with-events`** (AWS event ingestion — a two-step bundle: **`store-token`** writes a platform JWT to Secrets Manager at pipeline-builder's own pattern `pipeline-builder/{orgId}/platform`, then **`setup-events`** deploys the EventBridge → SQS → Lambda that reads it), and repeatable `--post-step "<cmd>"`. Default is register-only; `--no-init` skips even that. All steps are idempotent, so re-running with more options just layers them on.

The underlying `bin/setup.sh` / `bin/teardown.sh` scripts remain the source of truth and can always be run directly. Full guide: [AWS deployment → AI-assisted install](https://mwashburn160.github.io/pipeline-builder/docs/aws-deployment#ai-assisted-install-provision).

## Commands

### Platform installation

| Command | Purpose |
| --- | --- |
| `provision` | Install (or tear down) the **platform** on local/Minikube/EC2/Fargate: prereq checks + assembles the exact `bin/setup.sh` command, then **deploys it** (gated by confirmation; `--yes` for CI, `--json` to print the plan and run nothing), verifying health + running post-install steps. `--repo` bootstraps a fresh machine via a **sparse** clone of only the needed deploy folders; `--with-plugins`/`--with-compliance`/`--with-samples`/`--with-all`/`--with-smoke-test`/`--with-events`/`--post-step` add post-install steps; `--teardown` removes it. On failure it diagnoses + auto-fixes/retries known issues. See [Install the platform](#install-the-platform-provision). |

### Project lifecycle

| Command | Purpose |
| --- | --- |
| `bootstrap` | Scaffold a new pipeline project with `cdk.json` and starter config |
| `synth` | Run CDK synth to emit the CloudFormation template for the pipeline |
| `deploy` | Deploy the synthesized pipeline stack to AWS (also registers the pipeline with the platform by its `pipelineId`) |
| `register` | Re-register a deployed pipeline with the platform and drain pending intents queued by prior failed deploys (recovery path; exits non-zero if any registration still fails) |
| `status` | Report the current deployment and execution status |

### Resource management

| Command | Purpose |
| --- | --- |
| `create-pipeline` | Register a new pipeline definition with the platform |
| `list-pipelines` / `get-pipeline` | Inspect pipelines registered to your organization |
| `list-plugins` / `get-plugin` | Browse the plugin catalog and fetch a single plugin spec |
| `upload-plugin` | Publish a custom plugin spec + Dockerfile to the platform |
| `validate-templates` | Parse and validate `{{ ... }}` templates in a pipeline or plugin spec (local file, registered pipeline by ID, or registered plugin by `name:version`) |
| `org-export` | Export an organization's data as JSON for GDPR portability (sysadmins can export any org; org admins their own only) |

### Auth & infrastructure

| Command | Purpose |
| --- | --- |
| `login` | Authenticate against the platform and persist the access token (supports `--refresh <token>` and `--org <orgId>` to switch organizations) |
| `store-token` | Generate a long-lived JWT and store it in AWS Secrets Manager (used by the events Lambda and CodePipeline synth steps) |
| `setup-events` | Deploy the EventBridge → SQS → Lambda stack that streams CodePipeline events into the platform's reporting service |

### Operator audits (cron-friendly)

These commands report drift and exit non-zero when findings exist. Designed to run on a schedule.

| Command | Purpose | Exit codes |
| --- | --- | --- |
| `audit-stacks` | Diff CloudFormation stacks tagged `pipeline-builder` against the platform's `pipeline_registry`. Surfaces orphaned stacks (no DB row) and missing stacks (DB row but no live stack). See [docs/aws-deployment.md](https://mwashburn160.github.io/pipeline-builder/docs/aws-deployment.html#drift-detection-audit-stacks). | `0` clean / `1` findings / `2` AWS error |
| `audit-tokens` | Scan platform tokens stored in AWS Secrets Manager and flag any expiring within `--warn-days` (default 7). Run before tokens lapse to avoid silent reporting outages. | `0` clean / `1` at-risk / `2` AWS error |

### Misc

| Command | Purpose |
| --- | --- |
| `completions` | Print a shell completion script for `bash`, `zsh`, or `fish`. Source it from your shell profile, e.g. `eval "$(pipeline-manager completions bash)"` in `~/.bashrc` (completions are derived from the live command list, so they never drift) |
| `version` | Print CLI version info |

Run `pipeline-manager <command> --help` for the full flag reference on any command.

## Environment variables

| Variable | Required | Purpose |
| --- | --- | --- |
| `PLATFORM_TOKEN` | Yes (for API ops) | Auth token for the Pipeline Builder platform |
| `PLATFORM_BASE_URL` | Yes (for API ops) | Base URL of your platform deployment |
| `AWS_REGION` | Yes (for deploy) | Target AWS region for `synth` / `deploy` / `provision` teardown |
| `ANTHROPIC_API_KEY` (or other provider key) | No | Enables `provision`'s natural-language `--prompt` parsing + failure diagnosis (else it falls back to the deterministic issue matcher) |
| `AI_PROVIDER` / `AI_MODEL` | No | Provider + model for `provision` (`anthropic` \| `openai` \| `google` \| `xai` \| `bedrock`) |

Full reference: [Environment Variables](https://mwashburn160.github.io/pipeline-builder/docs/environment-variables).

## Documentation

- [Getting started](https://mwashburn160.github.io/pipeline-builder/)
- [CDK usage](https://mwashburn160.github.io/pipeline-builder/docs/cdk-usage)
- [Plugin catalog (125 plugins)](https://mwashburn160.github.io/pipeline-builder/docs/plugins/)
- [API reference](https://mwashburn160.github.io/pipeline-builder/docs/api-reference)
- [AWS deployment](https://mwashburn160.github.io/pipeline-builder/docs/aws-deployment)

## License

Apache-2.0. See [LICENSE](./LICENSE).