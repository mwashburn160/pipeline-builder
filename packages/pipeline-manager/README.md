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

`provision` is the recommended way to stand up the **platform itself** (not a pipeline) — on Docker Compose, Minikube, EC2, or Fargate. It runs read-only prerequisite checks, assembles the exact `bin/setup.sh` command (secrets masked, missing inputs reported — never guessed), and can run it end-to-end.

```bash
# Advisor (default) — prints the exact command + prereq results, runs nothing:
pipeline-manager provision --target local

# Execute (gated: confirm → deploy → verify /health + /ready → init-platform):
pipeline-manager provision --target fargate \
  --domain pipeline.example.com --hosted-zone-id Z123 --ghcr-token ghp_xxx --email --execute

# Tear it down (AWS targets prompt you to TYPE the target id to confirm):
pipeline-manager provision --target fargate --teardown --execute
```

- **Advise → execute → teardown.** Default is read-only. `--execute` deploys — it refuses on failed prerequisites or missing inputs, then verifies health and offers to run `init-platform`. `--teardown` removes a deployment (`local`/`minikube` stop the stack; **EC2/Fargate delete their CloudFormation stacks irreversibly** and require typing the target id to confirm — `--force` skips it for CI).
- **Self-healing.** On a failed deploy it matches known CloudFormation issues (cause + fix) and can auto-fix + retry a few — e.g. an existing SES identity → re-run with `--skip-ses-identity`. Gated and bounded by `--retries` (the scripts are idempotent, so a re-run resumes).
- **AI-optional.** Set `ANTHROPIC_API_KEY` (or `AI_PROVIDER` + its key) to parse a natural-language `--prompt` and add free-form failure diagnosis; without a key it falls back to the deterministic advisor + issue matcher.

The underlying `bin/setup.sh` / `bin/teardown.sh` scripts remain the source of truth and can always be run directly. Full guide: [AWS deployment → AI-assisted install](https://mwashburn160.github.io/pipeline-builder/docs/aws-deployment#ai-assisted-install-provision).

## Commands

### Platform installation

| Command | Purpose |
| --- | --- |
| `provision` | Install (or tear down) the **platform** on local/Minikube/EC2/Fargate: prereq checks + assembles the exact `bin/setup.sh` command; `--execute` runs it (gated, then verifies health + `init-platform`), `--teardown` removes it. On failure it diagnoses + auto-fixes/retries known issues. See [Install the platform](#install-the-platform-provision). |

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
| `ANTHROPIC_API_KEY` (or other provider key) | No | Enables `provision`'s natural-language `--prompt` parsing + failure diagnosis (else it falls back to the deterministic advisor) |
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