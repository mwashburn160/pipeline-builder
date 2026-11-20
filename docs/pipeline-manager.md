---
layout: default
title: Pipeline Manager (CLI)
---

<!--
Copyright 2026 Pipeline Builder Contributors
SPDX-License-Identifier: Apache-2.0
-->

# Pipeline Manager (CLI)

`pipeline-manager` is the command-line interface for Pipeline Builder.

## Highlights

- **It does two jobs.** It installs the platform itself, and it manages pipelines and plugins against a running one.
- **`infra provision` is the recommended installer** — and it does more than deploy: it also registers the initial admin and can load the catalogs and wire event reporting.
- **`--plan` is the only non-executing mode.** Everything else acts.
- **Tearing down an AWS target makes you type the cluster id.** There is no `--force` shortcut past it.
- **`PLATFORM_TOKEN` beats the stored session everywhere**, which is what makes the CLI usable in CI.
- **Every gate is the server's.** The CLI checks nothing itself and prints refusals as the server worded them.
- **Exit codes are stable and specific**, so CI can fail on the right things rather than on "non-zero".

## Overview

The CLI serves both operators who install the platform and developers who manage pipelines against a running one. It talks to the platform's REST API for resource operations and drives AWS CDK / CloudFormation for deploys.

This page covers installation, the [`infra provision`](#installing-the-platform-infra-provision) installer, the full [command reference](#command-reference), [configuration](#configuration) precedence, and [typical workflows](#typical-workflows).

## How it works

**Installing the platform:**

1. `infra provision` renders a plan for the chosen target, confirms it, then deploys.
2. It registers the initial `system` admin from the credentials you pass.
3. With `--with-all` it loads plugins, compliance rules and sample templates; with `--with-events` it stores the service tokens and wires event reporting on AWS.
4. It verifies `/health` and `/ready` before reporting success.

**Managing pipelines:**

1. You sign in — device authorization prints a code and opens your browser, storing a session — or export an access key as `PLATFORM_TOKEN`.
2. Commands call the platform's REST API, which applies every permission, quota and compliance gate.
3. Deploy commands shell out to `cdk`, then register the resulting stack with the platform by name and region.
4. The process exits with a specific code so a CI job fails on the right thing.

### The toolchain release (synth and deploy)

Every pipeline runs on a **toolchain release**: the `pipeline-bootstrap` build
image (the default CodeBuild image — the synth bootstrap, asset publishing and
plugin-less steps) and the `cdk-synth` synth plugin, published together under
one version. `pipeline synth` / `pipeline deploy` resolve it from the platform
on every run:

- **Which release.** The pipeline's own pin (`toolchain.release` in its config),
  else its organization's default, a canary the org is in, or the platform
  default. Both halves are looked up with the same pin, so they always come from
  one release.
- **No fallback.** If the bootstrap can't be resolved (platform unreachable, no
  platform default — `TOOLCHAIN_NO_DEFAULT`, a deleted pin, a refused signature)
  the synth stops with `BOOTSTRAP_IMAGE_UNRESOLVED`. A managed `cdk-synth`
  reference is fatal the same way, as is every other plugin that does not resolve.
- **What it pins.** The default image is
  `<platform>/system/pipeline-bootstrap@<digest>`, pulled with the org's
  `registry-push` secret exactly like a plugin image. `cliVersion` and
  `cdkAssetsCliVersion` are the release's `aws-cdk` / `cdk-assets` versions
  (never npm `latest`); explicit pipeline metadata
  (`aws:cdk:pipelines:codepipeline:cliversion`, `…:cdkassetscliversion`,
  `…:selfmutationcodebuilddefaults`, `…:assetpublishingcodebuilddefaults`) wins.
- **Self-mutation** runs on the AWS curated `aws/codebuild/standard:8.0` with its
  Node runtime pinned (`runtime-versions.nodejs`), so a defective release can
  always be rolled back.

**Pinning a release.** A pipeline pins the whole release — both halves — in its
config; a managed `cdk-synth` can't be pinned on its own
(`TOOLCHAIN_PIN_VIA_RELEASE`):

```jsonc
{
  "plugin": { "name": "cdk-synth" },
  "toolchain": { "release": "1.4.2" },   // optional; omit = org default, canary or platform default
  "stages": [ ... ]
}
```

- **Only eligible releases.** A pin is checked when it changes (`pipelines:write`):
  it must name a live release that has been the platform default or is your
  organization's canary (`GET /plugins/toolchain/eligible` lists them), else
  `TOOLCHAIN_RELEASE_NOT_ELIGIBLE`. A pipeline whose pinned release was later
  yanked still saves for unrelated edits.
- **Exact selection keeps working.** A yanked, deprecated or never-promoted pin
  still resolves, and `pipeline synth` prints its warning
  (`TOOLCHAIN_RELEASE_YANKED`, `_DEPRECATED`, `_INACTIVE`, `_NOT_PROMOTED`,
  [Error handling](error-handling.md#managed-toolchain)). A deleted one is a 404 and
  the synth stops with `BOOTSTRAP_IMAGE_UNRESOLVED`.
- **Templates never carry a pin.** Saving a template strips `toolchain`, and
  instantiating one ignores it.
- **The org's default** (Settings → Organization → Pipeline toolchain,
  `toolchain:manage`) applies to every pipeline that does not pin — see
  [Organization Benefits → Pipeline toolchain default](organization-benefits.md#pipeline-toolchain-default).

**Upgrading the CLI inside the synth step.** By default the `cdk-synth` step runs
the `pipeline-manager` baked into its release. To run a newer CLI without waiting
for a new release, opt in on the synth step's `env`:

```jsonc
{
  "plugin": { "name": "cdk-synth" },
  "env": {
    "PIPELINE_MANAGER_UPGRADE": "true",           // default "false"
    "PIPELINE_MANAGER_UPGRADE_VERSION": "4.5.3"   // optional: semver or dist-tag; default "latest"
  }
}
```

With only `PIPELINE_MANAGER_UPGRADE` set (or the version blank or `latest`), the
step runs a bare `pipeline-manager --upgrade` before synthesizing: the latest
release, and never a move backwards if the baked CLI is already newer. Any other
version is passed as `--upgrade <version>` and installed as named, downgrade
included. Either way it runs
with every check described under [Upgrading](#upgrading), including the registry
signature. Any refusal or failure fails the step, and a value other than `true`
or `false` is rejected. With it on, the step no longer runs the CLI the release
records, so release and canary data describe a CLI it didn't use. Pin a version
rather than `latest` if you need repeatable synths.
- **Escape hatch.** The raw `aws:cdk:codebuild:buildenvironment:buildimage`
  metadata key still overrides the image per step.

**Recovering a pipeline on a bad release.** Deployed pipelines pull the release
they were synthesized with by digest, so a yank changes nothing until the next
synth. To move one:

1. Change (or remove) its `toolchain.release` pin — or, for unpinned pipelines,
   change the org default or follow the platform default.
2. Re-run the pipeline, or `pipeline-manager pipeline deploy` it, so the next
   synth resolves the new release. Self-mutation runs on the AWS curated image,
   so it is never stuck on the bad one.
3. A pipeline whose **synth step itself** can't run on the bad release can't heal
   itself: redeploy it from a workstation with
   `pipeline-manager pipeline deploy --id <pipelineId>` (or `--local-spec` with a
   `--toolchain-file` exported for a good release).

**Local-spec deploys.** `pipeline deploy --local-spec` never contacts the
platform, so it takes the release from a file:

```bash
# Against the platform, once (add --release <V> to export a specific release):
pipeline-manager toolchain export --output toolchain.json

# Anywhere, without the platform:
pipeline-manager pipeline deploy --local-spec pipeline.json --toolchain-file toolchain.json
```

The file's platform host becomes the registry pull host (unless
`IMAGE_REGISTRY_PULL_HOST` is set). A pipeline that pins `toolchain.release` must
be given that release's export.

Only the managed `cdk-synth` comes from `--toolchain-file`. A local-spec deploy
looks up no other plugin, and every plugin must resolve before synth, so each
stage plugin (and a synth plugin other than `cdk-synth`) must already be in the
spec's `resolvedPlugins`, keyed by its alias. A plugin that isn't there fails the
synth naming the plugin and the step.

## Configuration

1. **Install the CLI** — see [Install](#install).
2. **Sign in, or set a token.** `pipeline-manager auth login` for a person; `PLATFORM_TOKEN` for CI, which takes precedence over a stored session everywhere.
3. **Point it at your platform** with the base URL, and at AWS with a region — precedence is documented in [Configuration precedence](#configuration-precedence).
4. **For installs, start with `--plan`** to inspect what would happen before anything runs.
5. **Add `--yes` for non-interactive CI**, and expect AWS teardowns to still demand the typed cluster id.
6. **Wire CI on the [exit codes](#exit-codes)** rather than on non-zero alone.

## Install

```bash
npm install -g @pipeline-builder/pipeline-manager
```

Requires **Node.js 26.13+** (any 26.13 patch or newer). The binary is exposed as `pipeline-manager`.

```bash
pipeline-manager --help            # global help
pipeline-manager <command> --help  # full flag reference for any command
pipeline-manager version           # CLI version info
```

### Upgrading

```bash
pipeline-manager --upgrade                # move to the latest release
pipeline-manager --upgrade 4.4.22         # move to a specific version (or a dist-tag), downgrades included
pipeline-manager --upgrade-check          # only report: exit 0 = current, 1 = a newer release exists
```

`--upgrade` is available from **4.4.21**. An older install needs one manual `npm install -g @pipeline-builder/pipeline-manager` first.

**No sign-in needed.** `--upgrade` and `--upgrade-check` talk only to the npm registry, never to the platform. They read no stored session or token and work signed out, so a CLI too old to sign in can still upgrade itself.

It reinstalls the CLI with the package manager that owns it (`npm` or `pnpm`, global). It uses the npm that belongs to the running Node, not whichever one is first on `PATH`. Before installing, it checks:

1. **Ownership.** The running copy must be a **global** npm or pnpm install. It refuses (exit 8) for npx, a project dependency, a source checkout or Volta, because reinstalling globally would leave that copy unchanged. Update those with whatever installed them.
2. **Direction.** A bare `--upgrade` never moves backwards. Naming a version is how to downgrade, but not below 4.4.21, which would leave no `--upgrade` to come back with.
3. **Node.** The target's `engines.node` must accept the running Node.
4. **Permissions.** The global directory must be writable, checked before anything is downloaded. If it isn't, the CLI prints the one command that needs root (`sudo npm install -g @pipeline-builder/pipeline-manager@<version>`) or how to move npm globals into your home directory. It never suggests `sudo pipeline-manager`, which would run the whole CLI, including its credential store, as root.
5. **Signature.** It downloads the release with `npm pack`. It checks that the tarball's sha512 matches the registry's `dist.integrity` and that npm's ECDSA signature over it verifies. Then it installs **that tarball**. npm's signing keys always come from `https://registry.npmjs.org/-/npm/v1/keys`, even when a mirror is configured: a mirror passes npm's signatures through, so it can't substitute its own key. With no route to registry.npmjs.org it fails closed. Set `PIPELINE_MANAGER_UPGRADE_SKIP_VERIFY=1` to install unverified.

Afterwards it reads the installed version back from disk and prints a link to the changes between the two releases.

| Exit | Meaning |
| --- | --- |
| 0 | upgraded, or already current |
| 1 | the download failed verification, or the version on disk is not the target (for `--upgrade-check`: a newer release exists) |
| 2 | not a semver or dist-tag, no such version or tag, or a version below 4.4.21 |
| 7 | the registry could not be reached |
| 8 | not a global npm/pnpm install, or the target needs a newer Node |
| 9 | the global directory is not writable, or the install failed; the old version is still installed |

**Update notice.** Once a day, a detached background process asks the registry for the latest release; no command ever waits on it. When a newer release is known, the CLI prints `Update available … run pipeline-manager --upgrade` to stderr on exit. It stays silent in CI (`CI` set), when stderr is not a terminal, under `--quiet` / `--token`, and when `PIPELINE_MANAGER_NO_UPDATE_CHECK=1` is set. The cache lives in `~/.pipeline-manager/update-check.json`.

**Minimum CLI version (operators).** Every platform call carries `X-Pb-Client-Version`. If `PIPELINE_MANAGER_MIN_VERSION` is set on the services (docker-compose passes it through `x-common-env`; in Kubernetes, add it to each service's env), an older CLI gets `426 CLIENT_UPGRADE_REQUIRED` with "run: pipeline-manager --upgrade". Requests without the header pass: browsers, other clients and CLIs from before 4.4.21. A malformed value stops the service from starting.

- **CI is never refused.** A request carrying `X-CodeBuild-Build-Id` runs the CLI baked into a plugin image, which doesn't upgrade itself unless the synth step opts in ([Upgrading the CLI inside the synth step](#the-toolchain-release-synth-and-deploy)). So it is counted (`caller="ci"`) but never refused. Raising the minimum therefore can't break pipelines; their images move when the plugin is rebuilt.
- **A compatibility check, not a security control.** The version header is set by the caller: a CLI can omit it or claim any version. Never use the minimum to shut out a CLI with a security flaw; revoke its tokens instead.
- An older CLI gets exit code **8** from a 426, the same as a local configuration problem, so scripts can tell it apart.

Before raising the minimum, check what is still calling. `pipeline_manager_requests_total{version}` counts requests per CLI version whether or not a minimum is set. Versions are reduced to `x.y.z`, and past 64 distinct values per process new ones count as `other`, because the header arrives before authentication. `pipeline_manager_upgrade_required_total{version,min}` counts the 426s. Audit rows record the CLI as `details._context.clientVersion`, as the caller claimed it. Each access key records the CLI version it was last used with (`lastClientVersion`), and Settings → Access keys shows it under **Last used**. An org admin can see which members' keys and service accounts still run an old CLI before the minimum goes up.

### Prerequisites for local pipeline deploys

`pipeline synth` / `pipeline deploy` run the **AWS CDK CLI**, so `cdk` must be on
`PATH`; they check for it and stop with the fix if it's missing. Nothing is bundled
on your machine and nothing is deployed to look plugins up — every plugin is
resolved by the CLI before synth — so neither esbuild, pnpm nor Docker is needed.
Install the CDK CLI version the
`pipeline-bootstrap` image bakes in (its `toolchain` in
`deploy/toolchain/pipeline-bootstrap/plugin-spec.yaml`):

```bash
npm install -g aws-cdk@2.1148.1
```

In CodeBuild this is handled for you — the bootstrap image ships the CDK CLI (see
[AWS deployment → the managed toolchain release](aws-deployment.md#build-the-managed-toolchain-release)).

---

## Quick start

```bash
# Sign in — prints a code, opens your browser to approve it, stores the session
pipeline-manager auth login --url https://platform.example.com

# Or capture just the token for this shell (CI, or a one-off scripted run).
# PLATFORM_TOKEN takes precedence over the stored session everywhere in the CLI.
export PLATFORM_TOKEN=$(pipeline-manager auth login --token)

# One-time per AWS account/region: deploy the CDK toolkit stack pipelines deploy into
pipeline-manager infra bootstrap --account 123456789012 --region us-east-1

# Register a pipeline definition (props.json from `template instantiate`, or your own)
pipeline-manager pipeline create -f props.json

# Synthesize the CDK app into a CloudFormation template
pipeline-manager pipeline synth --id <pipelineId>

# Deploy the pipeline to AWS (also registers it with the platform)
pipeline-manager pipeline deploy --id <pipelineId>
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
- **Run in Docker, zero host installs.** [`deploy/bin/provision-docker.sh`](https://github.com/mwashburn160/pipeline-builder/blob/main/deploy/bin/provision-docker.sh) runs `infra provision` inside a throwaway `node:26-slim` container, installing only the tools the chosen target needs. Args pass straight through. (On macOS the container can't drive Docker Desktop's CLI, so run **local** on the host instead — the wrapper shines for the AWS targets.)
- **Post-install steps.** After deploy + health, `infra provision` registers the admin (non-interactive with `--admin-email`/`--admin-password`) and runs opt-in loads — passed as flags or **offered interactively after the clone** when none are given: `--with-plugins` (adds `deploy/plugins`), `--with-compliance`, `--with-samples`, `--with-all`, `--with-smoke-test`, **`--with-events`** (AWS event ingestion: three `infra store-token` runs write the platform, `registry:push` and `reporting:ingest` service-account keys to Secrets Manager, then `infra setup-events --scoped-ingest` deploys the EventBridge → SQS → Lambda), and repeatable `--post-step "<cmd>"`. Default is register-only; `--init skip` skips even that. All steps are idempotent.

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
| `infra bootstrap` | Deploy the AWS CDK toolkit stack in the target account/region (`--account`, `--region`, `--qualifier`, `--trust` for cross-account deploys, `--cloudformation-execution-policies`) — needed once per account/region before the first `pipeline deploy` there. It scaffolds nothing: a pipeline definition comes from `template instantiate` + `pipeline create` |
| `pipeline synth` | Run CDK synth to emit the CloudFormation template for the pipeline |
| `pipeline deploy` | Deploy the synthesized pipeline stack to AWS (also registers the pipeline with the platform by its `pipelineId`). `--local-spec <pipeline.json>` deploys a local spec without contacting the platform; it **requires `--toolchain-file <path>`** (see below) and refuses with `BOOTSTRAP_IMAGE_UNRESOLVED` without one |
| `toolchain export` | Write the pipeline toolchain release as JSON: the release your organization resolves to now (its own default, a canary, or the platform default), or `--release <V>`. It holds both halves' (`pipeline-bootstrap`, `cdk-synth`) image repositories and signed digests, the release version and its tool versions, and the platform it came from. `--output <file>` (default stdout). Read-only. The input to `pipeline deploy --local-spec --toolchain-file` |
| `pipeline register` | Re-register a deployed pipeline and drain pending intents queued by prior failed deploys (recovery path; exits non-zero if any registration still fails) |
| `pipeline deregister` | Remove one `pipeline_registry` row by its registry id (`--id`, `--yes` required). The fix `audit stacks` prints for a missing-stack finding (a row whose stack was deleted out of band) |
| `pipeline delete` | Delete a pipeline definition (`--id`, `--yes` required). It does not touch AWS — a deployed stack keeps running and shows up in `audit stacks` as orphaned until destroyed |
| `pipeline run` | Start a deployed pipeline with **your own AWS credentials** (`--id`, optional `--region` / `--profile`, `--json`). The platform is asked only where the pipeline is (its registry row); the CLI then reads the CodePipeline's `pb.pipeline-id` tag and refuses unless it equals `--id`, and starts it with a fresh `clientRequestToken`. Region: `--region`, else the region recorded at deploy, else `AWS_REGION` / `AWS_DEFAULT_REGION` / `CDK_DEFAULT_REGION` / the profile's region. For teams that want no runner at all |
| `pipeline stop` | Stop a running execution with your own AWS credentials (`--id`, `--execution <id>`, optional `--abandon`, `--reason`). Same tag check as `pipeline run`, and the execution must belong to that pipeline |
| `status` | Show the CLI's setup — not a deployment: the platform it talks to, the credential it would use and when it expires, whether the platform **accepts** it (`GET /api/user/profile`, with who and which org), CDK availability and `/health` reachability |

### Resource management

| Command | Purpose |
| --- | --- |
| `pipeline create` | Register a new pipeline definition with the platform |
| `pipeline list` / `pipeline get` | Inspect pipelines registered to your organization |
| `plugin list` / `plugin get` | Browse the plugin catalog and fetch a single plugin spec |
| `plugin new` | Scaffold a plugin `FROM` a `plugin-<eco>-base` image (`--base`, list them with `--list-bases`): a `Dockerfile` that follows the catalog rules, a `plugin-spec.yaml` with catalog metadata (summary, description, version `0.1.0`, category, license, `smokeTest`, optional curated `--icon`, a changelog entry), `README.md` and `LICENSE`. It passes `plugin validate` and `test-plugins.sh` as generated. See [Authoring a plugin](#author-test-and-publish-a-plugin) |
| `plugin validate` | Validate a local plugin directory with the **server's** schemas (the spec and config schemas and the `{{ ... }}` contract, shared from api-core), then report every catalog field: its value, **where it would come from** (spec, README, Dockerfile label or generated) and whether it would be empty or invalid. `--lint` adds the catalog's Dockerfile rules; `--json` prints the report. Exits non-zero on any problem (CI-friendly) |
| `plugin test` | Run the plugin's install and build commands locally in its image (built from the plugin's `Dockerfile`, or `--image`) against a sample `--workspace`, as the image's non-root user, with the spec's env and `--metadata` / `--var` / `--env` values. Secrets are passed from your environment by name and never printed. It applies `failureBehavior`, checks that `primaryOutputDirectory` exists and is not empty, runs the `smokeTest`, and exits non-zero on any failure |
| `plugin publish` | Pre-flight (`plugin validate --lint`), a local scan preview (syft SBOM + grype, when installed), the accept-or-edit step for the detected catalog metadata, then one upload with `visibility=public` and `publishRequest=true`. `--yes` accepts everything detected, `--metadata <file.yaml>` supplies edits without prompting, and `--dry-run` uploads nothing. See [Plugin Publishing](plugin-publishing.md#publishing-from-the-cli) |
| `plugin upload` | Upload a custom plugin package (`--file <zip>`) to the platform. The name and version always come from the package's `plugin-spec.yaml` and the organization from your session; `--public` uploads it as `public` (needs `plugins:publish`, otherwise it is `org`), `--dry-run` checks the file without uploading |
| `plugin deprecate` | Deprecate one plugin version (`--id`, optional `--message` shown to its users). It keeps resolving, but synth warns, AI suggestions skip it, and orgs whose pipelines use it are notified. `--undo` clears it |
| `plugin yank` | Yank one plugin version (`--id`, required `--reason`): ranges, `latest` and the default stop resolving to it; exact pins still resolve with a warning. Yanking the default promotes the next version. A version published to the ecosystem is refused (409) |
| `template instantiate` | Render a golden-path pipeline template into concrete pipeline `props` — resolve it by `--name` (or `--id`), supply its declared inputs with repeatable `--input k=v` / `--inputs-file`, and write the result to `--output` (or stdout). **Creates nothing**: feed the props to `pipeline create --file`, which is where compliance and quota apply |
| `template validate` | Parse and validate `{{ ... }}` templates in a pipeline or plugin spec (local file, registered pipeline by ID, or registered plugin by `name:version`) |
| `org export` | Export an organization's data as JSON for GDPR portability (sysadmins can export any org; org admins their own only) |

### Auth & infrastructure

| Command | Purpose |
| --- | --- |
| `auth login` | Sign in through your **browser** using the OAuth 2.0 device authorization grant (RFC 8628): the CLI prints a short code, you approve it in the browser (where SSO and step-up already apply), and the session is stored in `~/.pipeline-manager/credentials.json`. `--org <orgId>` switches organization afterwards; `--no-browser` prints the URL instead of opening it. `--token` prints the access token and nothing else, for `export PLATFORM_TOKEN=$(pipeline-manager auth login --token)` — everything else, including the approval code, goes to stderr so the capture stays clean. There is **no password flag and no way to pass a refresh token** |
| `auth logout` | Sign this device out: revoke the stored session on the platform (`POST /api/auth/logout`, renewing an expired access token first) and delete it from `~/.pipeline-manager/credentials.json`. The local copy is always removed; when the platform can't be reached the command says so, and the device is then revoked from **Settings → Sessions and devices**. `PLATFORM_TOKEN` and access keys are untouched |
| `auth pat` | Create a named access key (`pb_pat_…`) for CI. Uses the same browser sign-in, and the approval doubles as the step-up the platform requires to create a key — so no password is typed here either. The key is printed **once** |
| `infra store-token` | Provision the org's machine identity — a **service account** plus one `pb_sa_…` key — and store the key in AWS Secrets Manager (read by CodeBuild's registry credentials, the events Lambda and `--store-tokens`). Add `--schedule` to also deploy a daily **key-rotation** stack (rotate → store → revoke) so the key never lapses. Re-run per scope (`--scope reporting:ingest`, `--scope registry:push`) — each is its own least-privilege account. With `PLATFORM_SECRET_NAME` set, the platform key is written to exactly that name and a `--scope` key to its sibling (`…/registry-push`, `…/reporting-ingest`), so running every scope in one shell never overwrites the platform secret. `--dry-run` prints the plan without signing in or calling the platform. Needs `PLATFORM_PASSWORD`: both writes are step-up gated |
| `infra setup-runner` | Install a **pipeline runner** in the AWS account your credentials point at. Runners are the **only** way the platform starts and stops pipelines (Run and Stop in the dashboard, plugin-upgrade redeploys), and the platform holds no AWS access to any account; every org can install them, with no feature flag. **One runner per AWS account per organization**: the command lists the account's runner stacks and reads each one's `RUNNER_ID`, refuses a second runner of your org there (update the existing one instead: same `--label` and `--region`), and installs beside another org's runner with a warning that a shared AWS account is a shared trust boundary (anyone with AWS access there can reach both orgs' pipelines), recommending distinct `--pipeline-prefix` values per org. If a parent organization's shared runner is already in the account, it warns that the team already reaches it and asks first (`--yes` to skip). It registers a pending runner (step-up), deploys `pipeline-builder-runner-<runnerId>` (the label is kept as the stack tag `pb.runner-label`) **once** with that runner's id, then sends the endpoint (a Lambda Function URL, or with `--api-gateway --allow-ip <cidr>...` an API Gateway that admits only the platform's egress IPs, rate-limited per source IP by an AWS WAF web ACL: `--waf-rate-limit <n>` requests per 5 minutes, default 1000, or `--no-waf` to leave it out) to the platform (step-up), which pings it and activates it on `pong`. `--regions <csv>` (default: the stack region) and `--pipeline-prefix <csv>` (default: your org's prefix, from its registered pipeline names) are the runner's local allowlist and scope its IAM role; `--pipeline-prefix '*'` covers every pipeline and requires `--yes`. It warns when the region has no `pipeline-builder-events` stack; `--with-events` runs `infra setup-events --scoped-ingest` afterwards. It prints the deployed bundle's SHA-256. Re-running updates the stack in place (and finishes a pending install). `--delete` revokes the runner the stack names on the platform, then deletes the stack (with no stack in that account and region it revokes only a still-pending runner of that label). `--dry-run` prints the plan and the exact IAM without calling AWS or the platform; `--json` for scripts. The endpoint URL is never printed. After registering it prints the runner's own JWKS URL (`<platform>/api/pipelines/runner/runners/<runnerId>/jwks.json`). A top-level org's runner signing key is created with its first runner; if your org has none, `--generate-key` generates it (same step-up) instead of stopping. See [Cross-account pipeline runner](aws-deployment.md#cross-account-pipeline-runner) |
| `runner signing-key status\|generate\|rotate\|finish` | Your organization's runner signing key, for scripts and settings-as-code; the same routes as the **Signing key** card in Settings → Organization → Pipeline runners. `status` shows the mode (own or inherited), the active, next and retiring key ids with their dates, and any rotation in progress. `generate` creates the first key (active at once; 409 if one exists), `rotate` publishes a new key that starts signing about 10 minutes later, and `finish` retires the old key once its hour is up. Every write needs `org_settings:write`, an MFA-grade session and step-up (`--step-up auto\|password\|totp\|browser`, `-p`/`PLATFORM_PASSWORD`), and is limited to 5 per org per hour. Only key ids and dates are ever printed; the key pair never leaves the platform. `--json` for scripts. See [secret rotation](runbooks/secret-rotation.md#runner-signing-keys-per-org-ed25519) |
| `infra setup-events` | Deploy the EventBridge → SQS → Lambda stack that streams CodePipeline events into the platform's reporting service. Add **`--with-dora`** to also resolve source commit timestamps in-account for **measured** commit→deploy lead time — off by default (**why:** it adds an SCM call + a `github-token`-secret read per deploy event, so only worthwhile for orgs on the `advanced_reporting` add-on; the other DORA metrics work without it and lead time simply reports `unknown`). Re-run to toggle. |
| `infra redrive-events` | Manual fallback for the events Lambda's self-healing redrive: move dead-lettered CodePipeline events from `pipeline-builder-events-dlq` back onto the ingestion queue via SQS `StartMessageMoveTask`. Skips the move when the DLQ is empty or a move task is already running; idempotent ingest prevents double-counting |

### Stakeholder reports

The add-on's six verbs. Two jobs the dashboard is the wrong shape for: **backfilling**
a run of past periods (a loop in a shell versus five careful clicks), and **unattended
operation** — a team producing its report from its own scheduler, or gating a publish
on a release finishing, needs a command with an exit code.

Every gate is the server's. The CLI checks nothing and prints a refusal as the server
worded it; `reports:write` covers `create` and `run`, `reports:publish` covers `publish`
and `link`, and the whole surface needs the `stakeholder_reports` feature.

| Command | Purpose |
| --- | --- |
| `report list` | This org's saved reports, their schedule, and the **pause reason** if any. |
| `report create` | Save a new scheduled report. The **creator owns it** — a scheduled run is authorized as the owner, so the API refuses an `ownerId` here. Timezone and week start fall back to the org's report defaults. |
| `report run` | Compose one period into a frozen snapshot. `--period 2026-W38` (or `2026-08`, `2026-Q3`); omit it for the last complete period. `--regenerate` produces version N+1 rather than returning the existing snapshot unchanged. |
| `report publish` | Publish a composed run (`--run <id>`). Idempotent: two publishes send one report, so a retried script is safe. |
| `report link` | Mint an expiring read-only link (`--run <id>`, `--expires-days`, `--redact-names`, which hides project/pipeline names and error text but keeps stage and action names and the numbers). **Shown once** — only a hash is stored, so a lost link is replaced, not recovered. |
| `report pdf` | Download a run as a PDF (`--run <id>`, `--out <file>`). Defaults to the file name the server chose, which carries the report title and the revision. Exits non-zero if the instance has no PDF renderer, so a scripted board pack cannot carry on believing it has a file. |
| `report transfer` | Hand a report to a new owner (`--id`, `--owner`). Future runs compute with **their** access, which can change what the report contains. |

```bash
# Backfill five weeks, oldest first, stopping at the first failure.
for w in 34 35 36 37 38; do
  pipeline-manager report run --id "$DEF" --period "2026-W$w" || break
done
```

### Operator audits (cron-friendly)

These commands report drift and **exit non-zero when findings exist** — designed to run on a schedule.

| Command | Purpose | Exit codes |
| --- | --- | --- |
| `audit stacks` | Diff the CloudFormation stacks tagged `pipeline-builder` in ONE region (`--region`) against your org's `pipeline_registry` rows for that region — every page of them. Surfaces orphaned stacks (no row) and missing stacks (a row, no live stack), each with the command that fixes it (`pipeline deregister`, `pipeline register` or `aws cloudformation delete-stack`); stacks tagged with another `OrgId` are skipped. `--org <id>` audits another org — honoured only for a credential the platform lets list it (a system admin); otherwise the command fails rather than diff the wrong org. `--max-pages` raises the DescribeStacks safety cap. See [drift detection](aws-deployment.md#drift-detection-audit-stacks). | `0` clean / `1` findings or an incomplete scan / `2` AWS or platform error |
| `audit tokens` | Scan platform tokens in AWS Secrets Manager and flag any expiring within `--warn-days` (default 7). Run before tokens lapse to avoid silent reporting outages. | `0` clean / `1` at-risk / `2` AWS error |

### Misc

| Command | Purpose |
| --- | --- |
| `completions` | Print a shell completion script for `bash`, `zsh`, or `fish`. Source it from your shell profile, e.g. `eval "$(pipeline-manager completions bash)"` in `~/.bashrc` (derived from the live command list, so they never drift) |
| `version` | Print CLI version info |

---

## Exit codes

Every command exits `0` on success. On failure the process exits with a **standard code
derived from the error type** (not the command), so scripts and CI can branch on the
class of failure consistently. The code is resolved centrally in `handleError` from the
actual error — typed CLI error → HTTP status → Node system-error `code` → a
command-specific fallback for anything unclassifiable.

| Code | Name | When |
| ---: | --- | --- |
| `0` | success | Command completed. |
| `1` | GENERAL | Unclassified failure (default fallback for non-API commands). |
| `2` | VALIDATION | Bad input — missing/invalid flags, malformed props file, HTTP `400`/`422`. |
| `3` | API_REQUEST | Platform API request failed (server `5xx`, or the fallback for API commands). |
| `4` | AUTHENTICATION | Not authenticated — HTTP `401` (e.g. expired/missing token). |
| `5` | AUTHORIZATION | Authenticated but not permitted — HTTP `403`. |
| `6` | NOT_FOUND | Resource missing — HTTP `404` (e.g. unknown pipeline id). |
| `7` | NETWORK | Request never reached the server — DNS/refused/reset, or no HTTP response. |
| `8` | CONFIGURATION | Invalid/missing CLI configuration. |
| `9` | FILE_SYSTEM | Local file error — `ENOENT`/`EACCES`/… (e.g. unreadable props file). |
| `10` | TIMEOUT | Timed out — HTTP `408`/`504`, or `ETIMEDOUT`. |

Codes are defined in `src/types/error.ts`; the derivation lives in `src/utils/error-handler.ts`
(`resolveExitCode`). The operator-audit commands keep their own contract instead: exit `1`
means "findings present" and exit `2` any AWS or platform failure, whatever its type
(see [Operator audits](#operator-audits-cron-friendly)).

---

## Configuration precedence

The CLI resolves its settings from these layers, lowest to highest precedence:

1. **Built-in defaults**
2. **User config file** — `~/.pipeline-manager/config.yml`
3. **Project config file** — `CLI_CONFIG_PATH`, else `./config.yml`
4. **The platform `auth login` signed in to** (base URL only) — so `auth login --url X` is followed by commands that talk to X, where its session is stored. `auth login`, `auth logout` and `auth pat` default `--url` to the resolved base URL too.

Environment variables (`PLATFORM_BASE_URL`, …) override the resolved config.

A config file's `api.rejectUnauthorized: false` turns TLS verification off for a dev platform, like `PLATFORM_TLS_VERIFY=false`, and is ignored the same way under `NODE_ENV=production` (with a warning; verification stays on).

**How commands authenticate**, in priority order:

1. `PLATFORM_TOKEN` — always wins. This is what CI sets, to an access key from `auth pat`.
2. The session `auth login` stored for **this platform's base URL**, in `~/.pipeline-manager/credentials.json` (owner-only, `0600`). It carries the access token and its refresh token, so the CLI renews the session itself and you sign in roughly as often as the refresh token's 30-day life requires. A renewal the platform **rejects** (400/401) forgets the session; an unreachable platform or a 5xx keeps it and reports the error, so a network blip never forces a new browser sign-in.
3. `--store-tokens` with `PLATFORM_SECRET_NAME` — the service-account key in AWS Secrets Manager (`infra store-token`). A command given `--store-tokens` never falls back to your personal session.

Sign a stored session out with `pipeline-manager auth logout`, or from the dashboard (**Settings → Sessions and devices**) — it appears there as a signed-in device like any other.

### Environment variables

| Variable | Required | Purpose |
| --- | --- | --- |
| `PLATFORM_TOKEN` | No | Access key or token for the platform. Overrides the stored `auth login` session — set it in CI, leave it unset on a workstation |
| `PLATFORM_BASE_URL` | No | Base URL of your platform. Overrides the platform `auth login` signed in to and the config files |
| `AWS_REGION` | Yes (for deploy) | Target AWS region for `pipeline synth` / `pipeline deploy` / `infra provision` teardown |
| `CLI_CONFIG_PATH` | No | Override the project config file path (default `./config.yml`) |
| `UPLOAD_TIMEOUT_MS` | No | Override the plugin-upload request timeout (ms) |
| `PLATFORM_TLS_VERIFY` | No | Set to `false` to skip TLS verification of the platform, for a dev platform on a self-signed certificate (`NODE_TLS_REJECT_UNAUTHORIZED=0` counts the same). Ignored in `NODE_ENV=production`. The one name for this switch: the CLI, the synth and the key-rotation Lambda all read it. Prefer `PLATFORM_CA_BUNDLE`, which keeps verification on |
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
pipeline-manager infra bootstrap --account 123456789012 --region us-east-1   # once per account/region
pipeline-manager pipeline create -f props.json
pipeline-manager pipeline synth --id <pipelineId>
pipeline-manager pipeline deploy --id <pipelineId>
pipeline-manager status
```

### Start from a golden-path template

```bash
# Render the template into concrete props (nothing is created yet) …
pipeline-manager template instantiate \
  --name react-javascript \
  --project react --organization AcmeCorp \
  --input orgId=1234abcd-... \
  --output pipeline-props.json

# … then create + deploy from them, through the normal (compliance + quota) path
pipeline-manager pipeline create --file pipeline-props.json --deploy --region us-east-1
```

Pipe it instead of writing a file with `--json`, which suppresses all decorative
output: `pipeline-manager template instantiate --name react-javascript -p react -o AcmeCorp --json | jq .stages`.

### Author, test and publish a plugin

```bash
pipeline-manager plugin new --list-bases
pipeline-manager plugin new --name acme-lint --category quality --base node --license MIT

# Edit Dockerfile (install the tool via fetch-verified) and plugin-spec.yaml (commands), then:
pipeline-manager plugin validate --dir ./acme-lint --lint
pipeline-manager plugin test --dir ./acme-lint --workspace ./sample-app --metadata STAGE=dev
pipeline-manager plugin publish --dir ./acme-lint
```

- **Bases.** The Dockerfile starts `FROM plugin-<eco>-base` (`plugin`, `aws-cli`, `cpp`, `dotnet`, `go`, `jvm`, `node`, `php`, `python`, `ruby`, `rust`, `trivy`). `plugin test` and the scan preview build it locally, so build the bases first with `deploy/bin/build-plugin-images.sh`, or pass `--image`.
- **Icons.** `--icon` takes a curated key from `deploy/plugins/_icons`. Curated marks are for Official listings and Verified publishers who own them. A Community listing uploads a raster icon or shows its monogram, so the default is none.
- **`plugin test` is red, never green, when anything fails.** A step that fails under `failureBehavior: fail`, a missing or empty `primaryOutputDirectory`, an image that runs as root, a failed `smokeTest`, a required secret missing from your environment, or a `{{ ... }}` value you didn't supply all exit non-zero. `warn` and `ignore` behave as they do in the pipeline, and a security-category plugin always runs as `fail`.
- **`plugin publish` never passes silently.** Without syft and grype on `PATH` it prints that the scan preview did not run (the platform still scans after the build). A critical vulnerability, a lint error or a missing license or README stops it before anything is uploaded. Without a terminal it needs `--yes` or `--metadata`.

### Reference an ecosystem plugin

A pipeline step can name a plugin by `publisher` as well as `name`. The CLI passes `publisher` through to lookup at synth.

```yaml
plugin: { name: trivy }                                                     # own org, parent org, then the Official listing
plugin: { publisher: acme, name: terraform-plan, filter: { version: '^1' } } # only acme's listing, through your install
```

- A qualified reference resolves only that publisher's listing, and only through an install. Install it first (dashboard → Plugins, or `POST /api/plugins/installs`). Official listings (`pipeline-builder`) are installed implicitly.
- `pipeline create` (and every other create or update path) refuses a qualified reference that isn't installed, is blocked by the org's consumption policy or can't resolve, with `400` and the per-step reasons. It also checks the plugin contract of listed versions.
- Lookup verifies the image signature (and, for a listing, the signed trust tier and publisher) and returns `imageRepository`; synth pins `<repository>@<digest>`. Warnings such as `PLUGIN_SHADOWS_LISTING` or `PLUGIN_SECRETS_WITHHELD` are printed.
- **Every plugin must resolve, or the synth fails.** A step never ships without its plugin. `pipeline synth` looks up every reference, then fails once with every refusal, each naming the plugin and its cause: `IMAGE_VERIFICATION_FAILED`, `PLUGIN_NOT_INSTALLED`, `PLUGIN_BLOCKED_BY_POLICY`, `PLUGIN_UNAVAILABLE`, `PLUGIN_DELETED`, `PLUGIN_VERSION_NOT_FOUND` (an exact pin that does not exist), `PLUGIN_NOT_FOUND` (nothing matches a range or default reference) or `PLUGIN_LOOKUP_FAILED` (the lookup got no answer: the platform was unreachable, or it returned an auth or server error). Inside CodeBuild the same codes go on the `PB_SYNTH_FAILURE` line the execution event carries.
- A qualified step's construct id is `<publisher>-<name>` (when it has no alias) and its default artifact alias is `<publisher>-<name>-alias`. Unqualified references are unchanged.

See [Plugin Installing](plugin-installing.md) for installs, version policies and the resolution order.

### Run pipelines through a runner

Runners are the only way the platform runs pipelines, so install one before the first Run (a pipeline with none answers `NO_RUNNER`). One runner per AWS account per organization covers every region it lists.

```bash
# In the pipelines' account, with that account's credentials (once per account):
pipeline-manager infra setup-runner --region us-east-1 --regions us-east-1,eu-west-2 --dry-run   # review the IAM
pipeline-manager infra setup-runner --region us-east-1 --regions us-east-1,eu-west-2 --with-events
# Run / Stop in the dashboard now reach those pipelines. Without the platform, with your own credentials:
pipeline-manager pipeline run  --id <pipelineId> --profile customer-account
pipeline-manager pipeline stop --id <pipelineId> --execution <executionId> --profile customer-account
# Remove it (revokes on the platform first, then deletes the stack):
pipeline-manager infra setup-runner --region us-east-1 --delete
# The organization's signing key (rotate yearly; the dashboard reminds you):
pipeline-manager runner signing-key status
pipeline-manager runner signing-key rotate      # signs in ~10 minutes
pipeline-manager runner signing-key finish      # after the old key's hour is up (the sweep also does it)
```

### Schedule drift detection (cron)

```bash
# Non-zero exit on findings makes these CI/cron friendly
pipeline-manager audit stacks --region us-east-1 || alert "stack drift detected"
pipeline-manager audit tokens --warn-days 14 || alert "tokens expiring soon"
```

---

## Related documentation

- [AWS Deployment](aws-deployment.md) — EC2/EKS deploy, post-deploy setup, drift detection
- [CDK Usage](cdk-usage.md) — the `PipelineBuilder` construct used by bootstrapped projects
- [API Reference](api-reference.md) — REST endpoints the CLI calls
- [Template Syntax](templates.md) — `{{ ... }}` interpolation validated by `template validate`
- [Environment Variables](environment-variables.md) — full configuration reference
