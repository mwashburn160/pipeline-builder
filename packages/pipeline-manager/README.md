# @pipeline-builder/pipeline-manager

📖 **[View documentation](https://mwashburn160.github.io/pipeline-builder/)**

CLI for [Pipeline Builder](https://mwashburn160.github.io/pipeline-builder/): install the platform itself with `provision`, then bootstrap, synth, deploy, and manage CDK pipelines + plugins against it.

## Install

```bash
npm install -g @pipeline-builder/pipeline-manager
```

Requires Node.js 26.13.1+.

## Quick start

```bash
# Sign in — prints a short code, opens your browser to approve it, and stores
# the session in ~/.pipeline-manager/credentials.json (no password on the CLI).
# The platform you sign in to becomes the one every later command talks to.
pipeline-manager auth login --url https://platform.example.com

# One-time per AWS account/region: deploy the CDK toolkit stack pipelines deploy into
pipeline-manager infra bootstrap --account 123456789012 --region us-east-1

# Register a pipeline definition (props.json from `template instantiate`, or your own)
pipeline-manager pipeline create -f props.json

# Synthesize the CDK app into a CloudFormation template, then deploy it to AWS
pipeline-manager pipeline synth --id <pipelineId>
pipeline-manager pipeline deploy --id <pipelineId>
```

## Install the platform (`provision`)

`provision` is the recommended way to stand up the **platform itself** (not a pipeline) — on Docker Compose, Minikube, EC2, or EKS (Auto Mode). It runs prerequisite checks, assembles the exact `bin/setup.sh` command (secrets masked, missing inputs reported — never guessed), shows the plan, and **deploys it end-to-end, gated by confirmation prompts** (`--yes` for CI; `--json` prints the plan and runs nothing).

```bash
# Deploy local — shows the plan, then confirms (confirm → deploy → /health + /ready → init-platform):
pipeline-manager infra provision --target docker

# Inspect the plan as JSON, run nothing:
pipeline-manager infra provision --target docker --json

# Deploy to EKS Auto Mode (add --yes for non-interactive CI):
pipeline-manager infra provision --target eks \
  --domain pipeline.example.com --hosted-zone-id Z123 --ghcr-token ghp_xxx --email

# Tear it down (AWS targets prompt you to TYPE the cluster/target id to confirm):
pipeline-manager infra provision --target eks --teardown

# Bootstrap a fresh machine — sparse-clones ONLY the deploy folders this target
# + options need (here: deploy/bin + deploy/local/docker), then deploys + registers:
pipeline-manager infra provision --target docker --repo --yes \
  --admin-email admin@acme.com --admin-password 's3cret'

# Add post-install loads (each also adds its folder to the sparse clone):
pipeline-manager infra provision --target docker --repo --with-all --with-smoke-test
```

- **Deploy (gated) or teardown.** `provision` shows the plan, then deploys — refusing on failed prerequisites or missing inputs, confirming before it runs (`--yes` auto-accepts for CI), then verifying health and running `init-platform`. **`--json`** prints the plan and runs nothing (the only non-executing mode). `--teardown` removes a deployment (`local`/`minikube` stop the stack; **EC2 deletes its CloudFormation stack and EKS runs `bin/shutdown.sh` (cluster + EFS + ACM + Route 53), both irreversibly** and require typing the stack/cluster id to confirm — `--force` skips it for CI).
- **Prerequisites, handled.** The checks mirror each target's `setup.sh` exactly — local: Docker, Docker Compose, `yq`, `openssl`; minikube: Docker, minikube, kubectl, `openssl` (+ `yq` with `--with-plugins`); ec2: AWS CLI + working credentials; eks: AWS CLI + credentials, `kubectl`, `openssl`, `envsubst` (+ `yq` with `--with-plugins`); `eksctl` is auto-installed by `setup.sh` (latest binary) when not already on PATH. Missing **single-binary** tools (`yq`, `kubectl`, `minikube`) are offered as an on-demand **fetch** into `~/.pipeline-manager/tools` and put on PATH — no `brew`/`apt`, no system change. For local/minikube it also **creates the target's `.env`** from `.env.example`, generating the `CHANGE_ME` secrets. Tools that aren't relocatable binaries (git, Docker/Compose, AWS CLI, openssl) fall back to the normal install instruction, and if you run from outside a checkout it **offers to sparse-clone** the deploy folders for you.
- **Self-healing.** On a failed deploy it matches known CloudFormation issues (cause + fix) and can auto-fix + retry a few — e.g. an existing SES identity → re-run with `--skip-ses-identity`. Gated and bounded by `--retries` (the scripts are idempotent, so a re-run resumes).
- **AI-optional.** Set `ANTHROPIC_API_KEY` (or `AI_PROVIDER` + its key) to parse a natural-language `--prompt` and add free-form failure diagnosis; without a key it falls back to the deterministic issue matcher.
- **Bootstrap a fresh machine (`--repo`).** Without a checkout, `--repo` git-clones the platform repo first, then runs from it. The clone is **sparse + partial** (`--filter=blob:none` + cone `sparse-checkout`, git ≥ 2.27 — else a full-clone fallback): it materializes only the deploy folders the selected target + options need. The common base is just `deploy/bin`; each target adds its own folder (e.g. `deploy/local/docker`; minikube is self-contained), and each post-install load adds its folder. Re-syncs are **additive** — a single `--workdir` can accumulate multiple targets. Override with `--repo <url>`, `--ref <branch|tag>`, `--workdir <dir>`.
- **Run in Docker, zero host installs.** Don't want `git`/`yq`/AWS CLI on your machine? [`deploy/bin/provision-docker.sh`](../../deploy/bin/provision-docker.sh) runs `provision` inside a throwaway `node:26-slim` container, installing only the tools the chosen target needs: **ec2** → git + AWS CLI (mounts `~/.aws` read-only); **eks** → + openssl + envsubst + eksctl + kubectl (mounts `~/.aws` + `~/.kube`); **local** → git + yq + openssl, with **Docker + Docker Compose used *externally*** from the host via the mounted socket (Docker Desktop already provides them — they're never installed in the image). Host footprint = just Docker. Args pass straight through: `deploy/bin/provision-docker.sh --target eks --repo --domain … --yes`. (On macOS the container can't drive Docker Desktop's CLI, so run **local** on the host instead — the wrapper shines for the AWS targets.)
- **Post-install steps.** After deploy + health, `provision` registers the admin (non-interactive with `--admin-email`/`--admin-password`) and runs the opt-in loads — passed as flags, or **offered interactively after the clone** when none are given (each picked load is then fetched via an additive sparse re-sync): `--with-plugins` (adds `deploy/plugins`), `--with-compliance` (`deploy/compliance`), `--with-samples` (`deploy/samples`), or `--with-all`. Plus `--with-smoke-test` (read-only API check), **`--with-events`** (AWS event ingestion — a two-step bundle: **`store-token`** writes a platform JWT to Secrets Manager at pipeline-builder's own pattern `pipeline-builder/{orgId}/platform`, then **`setup-events`** deploys the EventBridge → SQS → Lambda that reads it), and repeatable `--post-step "<cmd>"`. Default is register-only; `--init skip` skips even that. All steps are idempotent, so re-running with more options just layers them on.

The underlying `bin/setup.sh` / `bin/shutdown.sh` scripts (and `aws cloudformation delete-stack` for ec2) remain the source of truth and can always be run directly. Full guide: [AWS deployment → AI-assisted install](https://mwashburn160.github.io/pipeline-builder/docs/aws-deployment#ai-assisted-install-provision).

## Commands

Commands are grouped by task: `pipeline-manager <group> <verb>`. `pipeline-manager --help` lists the groups and `pipeline-manager <group> --help` a group's verbs.

### `auth` — credentials

| Command | Purpose |
| --- | --- |
| `auth login` | Sign in through your browser (device authorization — no password on the command line) and store the session for that platform. The platform becomes the active one for later commands (`PLATFORM_BASE_URL` still overrides it). `--org <orgId>` switches organization; `--token` / `--quiet` print the token for `export PLATFORM_TOKEN=…` |
| `auth logout` | Revoke the stored session on the platform (`POST /auth/logout`) and delete it from this device. The local copy is removed even when the platform can't be reached — the command then says to revoke the device from Settings → Sessions and devices |
| `auth pat` | Create a named access key (`pb_pat_…`, long-lived, for CI as `PLATFORM_TOKEN`). The step-up is approved in the browser; the key is printed once |

### `pipeline` — define, deploy and reconcile pipelines

| Command | Purpose |
| --- | --- |
| `pipeline create` | Register a pipeline definition from a props file (`--deploy` to also deploy it) |
| `pipeline list` / `pipeline get` | Inspect the pipelines your organization can see |
| `pipeline synth` | Run CDK synth to emit the CloudFormation template for a pipeline |
| `pipeline deploy` | Deploy the synthesized stack to AWS (also registers the deployment by its `pipelineId`). `--local-spec <pipeline.json>` deploys without the platform and needs `--toolchain-file` (from `toolchain export`) |
| `pipeline register` | Re-register a deployed pipeline and drain registrations queued by failed deploys (recovery path; non-zero exit if any still fails) |
| `pipeline deregister` | Remove one `pipeline_registry` row by its registry id (`--yes` required) — the fix for an `audit stacks` missing-stack finding |
| `pipeline delete` | Delete a pipeline definition (`--yes` required). A deployed stack is left in AWS |

### `plugin` — author and publish plugins

| Command | Purpose |
| --- | --- |
| `plugin new` | Scaffold a plugin from a `plugin-<eco>-base` image (Dockerfile, spec, README, LICENSE) |
| `plugin validate` | Validate a local plugin with the server's schemas and report its catalog metadata |
| `plugin test` | Run a plugin's install + build commands locally in its image against a sample workspace |
| `plugin publish` | Pre-flight, scan-preview and upload a plugin, then request its listing in the plugin ecosystem |
| `plugin upload` | Upload and deploy a plugin package |
| `plugin list` / `plugin get` | Browse the plugin catalog and fetch one plugin |
| `plugin deprecate` | Deprecate a version (it keeps resolving, with a warning); `--undo` clears it |
| `plugin yank` | Yank a version (stops resolving for ranges, `latest` and the default) |
| `plugin verify` | Report the current vulnerability state of a pipeline's pinned plugin images at run time (never fails on it) |

### `template` — golden-path templates

| Command | Purpose |
| --- | --- |
| `template instantiate` | Render a pipeline template into concrete pipeline props (creates nothing) |
| `template validate` | Parse and validate `{{ ... }}` templates in a local file, a registered pipeline (by id) or a registered plugin (`name:version`) |

### `infra` — AWS and platform infrastructure

| Command | Purpose |
| --- | --- |
| `infra bootstrap` | Deploy the AWS CDK toolkit stack in the target account/region (`--account`, `--qualifier`, `--trust` for cross-account) — needed once before the first `pipeline deploy` there |
| `infra setup-events` | Deploy the EventBridge → SQS → Lambda stack that streams CodePipeline events into reporting |
| `infra redrive-events` | Move dead-lettered CodePipeline events back onto the ingestion queue (manual fallback for the Lambda's own redrive) |
| `infra store-token` | Provision an org service-account key and store it in AWS Secrets Manager for CDK synth steps and the events Lambda (`--schedule` adds daily auto-renewal) |
| `infra provision` | Install (or `--teardown`) the **platform** on local/Minikube/EC2/EKS. See [Install the platform](#install-the-platform-provision) |

### `audit` — operator audits (cron-friendly)

These report drift and exit non-zero when there are findings. Designed to run on a schedule.

| Command | Purpose | Exit codes |
| --- | --- | --- |
| `audit stacks` | Diff the CloudFormation stacks tagged `pipeline-builder` in ONE region (`--region`) against your org's `pipeline_registry` rows for that region (every page). Surfaces orphaned stacks (no registry row) and missing stacks (a row but no live stack), each with the command that reconciles it. `--org` audits another org when your credential may list it (a system admin). See [drift detection](https://mwashburn160.github.io/pipeline-builder/docs/aws-deployment.html#drift-detection-audit-stacks). | `0` clean / `1` findings or an incomplete scan / `2` AWS or platform error |
| `audit tokens` | Scan platform tokens stored in AWS Secrets Manager and flag any expiring within `--warn-days` (default 7) | `0` clean / `1` at-risk / `2` AWS error |

### Other groups

| Command | Purpose |
| --- | --- |
| `toolchain export` | Write the pipeline toolchain release your org resolves to (or `--release <V>`) as JSON: both images' repositories and signed digests, the release and its tool versions — the input to `pipeline deploy --local-spec --toolchain-file` |
| `org export` | Export an organization's data as JSON for GDPR portability (sysadmins any org; org admins their own) |
| `report list` / `create` / `run` / `publish` / `link` / `pdf` / `transfer` | Stakeholder reports: save a scheduled report, compose a period (or backfill past ones), publish it, mint a read-only link, download the PDF, hand it to a new owner |
| `security-report upload` | Upload a SARIF / trivy / grype report produced inside a pipeline |
| `status` | Show the CLI's setup: the platform it talks to, the credential it would use and its expiry, whether the platform accepts it (and as whom), CDK availability and `/health` reachability |
| `version` | Print CLI version info (`--check-config` validates the configuration) |
| `completions` | Print a shell completion script for `bash`, `zsh` or `fish`, e.g. `eval "$(pipeline-manager completions bash)"` (derived from the live command tree, so it never drifts) |

Run `pipeline-manager <command> --help` for the full flag reference on any command.

## Environment variables

| Variable | Required | Purpose |
| --- | --- | --- |
| `PLATFORM_TOKEN` | No | Access key or token; overrides the stored `auth login` session (what CI uses) |
| `PLATFORM_BASE_URL` | No | Base URL of your platform; overrides the platform `auth login` signed in to and `config.yml` |
| `AWS_REGION` | Yes (for deploy) | Target AWS region for `synth` / `deploy` / `provision` teardown |
| `ANTHROPIC_API_KEY` (or other provider key) | No | Enables `provision`'s natural-language `--prompt` parsing + failure diagnosis (else it falls back to the deterministic issue matcher) |
| `AI_PROVIDER` / `AI_MODEL` | No | Provider + model for `provision` (`anthropic` \| `openai` \| `google` \| `xai` \| `bedrock`) |

Full reference: [Environment Variables](https://mwashburn160.github.io/pipeline-builder/docs/environment-variables).

## Documentation

- [Getting started](https://mwashburn160.github.io/pipeline-builder/)
- [CDK usage](https://mwashburn160.github.io/pipeline-builder/docs/cdk-usage)
- [Plugin catalog (118 plugins)](https://mwashburn160.github.io/pipeline-builder/docs/plugins/)
- [API reference](https://mwashburn160.github.io/pipeline-builder/docs/api-reference)
- [AWS deployment](https://mwashburn160.github.io/pipeline-builder/docs/aws-deployment)

## License

Apache-2.0. See [LICENSE](./LICENSE).