// GENERATED FROM docs/pipeline-manager.md — DO NOT EDIT.
// Regenerate: npm run generate:help  (see frontend/scripts/generate-help.mjs)
// SOURCE-SHA256: 2654a201e94dd58219e787fe671f84522d22a84e22c47dfdfeac0ca78f726ff8
// SPDX-License-Identifier: Apache-2.0
import { Terminal } from 'lucide-react';
import type { HelpTopic } from '../types';

export const cliReferenceTopic: HelpTopic = {
  "icon": Terminal,
  "id": "cli-reference",
  "title": "CLI Reference",
  "description": "Pipeline Manager CLI commands and usage",
  "sections": [
    {
      "id": "overview",
      "title": "Overview",
      "blocks": [
        {
          "type": "text",
          "content": "pipeline-manager is the command-line interface for Pipeline Builder."
        }
      ]
    },
    {
      "id": "highlights",
      "title": "Highlights",
      "blocks": [
        {
          "type": "list",
          "items": [
            "It does two jobs. It installs the platform itself, and it manages pipelines and plugins against a running one.",
            "infra provision is the recommended installer — and it does more than deploy: it also registers the initial admin and can load the catalogs and wire event reporting.",
            "--json is the only non-executing mode of infra provision. It prints the plan; everything else acts.",
            "Tearing down an AWS target makes you type the stack/cluster id. Only --force (for CI) skips it; --yes does not.",
            "PLATFORM_TOKEN beats the stored session everywhere, which is what makes the CLI usable in CI.",
            "Every gate is the server's. The CLI checks nothing itself and prints refusals as the server worded them.",
            "Exit codes are stable and specific, so CI can fail on the right things rather than on \"non-zero\"."
          ]
        }
      ]
    },
    {
      "id": "overview",
      "title": "Overview",
      "blocks": [
        {
          "type": "text",
          "content": "The CLI serves both operators who install the platform and developers who manage pipelines against a running one. It talks to the platform's REST API for resource operations and drives AWS CDK / CloudFormation for deploys."
        },
        {
          "type": "text",
          "content": "This page covers installation, the infra provision installer, the full command reference, configuration precedence, and typical workflows."
        }
      ]
    },
    {
      "id": "how-it-works",
      "title": "How it works",
      "blocks": [
        {
          "type": "text",
          "content": "Installing the platform:"
        },
        {
          "type": "list",
          "items": [
            "infra provision renders a plan for the chosen target, confirms it, then deploys.",
            "It registers the initial system admin from the credentials you pass.",
            "With --with-all it loads plugins, compliance rules and sample templates; with --with-events it stores the service tokens and wires event reporting on AWS.",
            "It verifies /health and /ready before reporting success."
          ]
        },
        {
          "type": "text",
          "content": "Managing pipelines:"
        },
        {
          "type": "list",
          "items": [
            "You sign in — device authorization prints a code and opens your browser, storing a session — or export an access key as PLATFORM_TOKEN.",
            "Commands call the platform's REST API, which applies every permission, quota and compliance gate.",
            "Deploy commands shell out to cdk, then register the resulting stack with the platform by name and region. The stack name derives from the pipeline's project and organization — see Pipeline stack names.",
            "The process exits with a specific code so a CI job fails on the right thing."
          ]
        },
        {
          "type": "text",
          "content": "The toolchain release (synth and deploy)"
        },
        {
          "type": "text",
          "content": "Every pipeline runs on a toolchain release: the pipeline-bootstrap build image (the default CodeBuild image — the synth bootstrap, asset publishing and plugin-less steps) and the cdk-synth synth plugin, published together under one version. pipeline synth / pipeline deploy resolve it from the platform on every run:"
        },
        {
          "type": "list",
          "items": [
            "Which release. The pipeline's own pin (toolchain.release in its config),"
          ]
        },
        {
          "type": "text",
          "content": "else its organization's default, a canary the org is in, or the platform default. Both halves are looked up with the same pin, so they always come from one release."
        },
        {
          "type": "list",
          "items": [
            "No fallback. If the bootstrap can't be resolved (platform unreachable, no"
          ]
        },
        {
          "type": "text",
          "content": "platform default — TOOLCHAIN_NO_DEFAULT, a deleted pin, a refused signature) the synth stops with BOOTSTRAP_IMAGE_UNRESOLVED. A managed cdk-synth reference is fatal the same way, as is every other plugin that does not resolve."
        },
        {
          "type": "list",
          "items": [
            "What it pins. The default image is"
          ]
        },
        {
          "type": "text",
          "content": "<platform>/system/pipeline-bootstrap@<digest>, pulled with the org's registry-push secret exactly like a plugin image. cliVersion and cdkAssetsCliVersion are the release's aws-cdk / cdk-assets versions (never npm latest); explicit pipeline metadata (aws:cdk:pipelines:codepipeline:cliversion, …:cdkassetscliversion, …:selfmutationcodebuilddefaults, …:assetpublishingcodebuilddefaults) wins."
        },
        {
          "type": "list",
          "items": [
            "Self-mutation runs on the AWS curated aws/codebuild/standard:8.0 with its"
          ]
        },
        {
          "type": "text",
          "content": "Node runtime pinned (runtime-versions.nodejs), so a defective release can always be rolled back."
        },
        {
          "type": "text",
          "content": "Pinning a release. A pipeline pins the whole release — both halves — in its config; a managed cdk-synth can't be pinned on its own (TOOLCHAIN_PIN_VIA_RELEASE):"
        },
        {
          "type": "code",
          "content": "{\n  \"plugin\": { \"name\": \"cdk-synth\" },\n  \"toolchain\": { \"release\": \"1.4.2\" },   // optional; omit = org default, canary or platform default\n  \"stages\": [ ... ]\n}",
          "language": "jsonc"
        },
        {
          "type": "list",
          "items": [
            "Only eligible releases. A pin is checked when it changes (pipelines:write):"
          ]
        },
        {
          "type": "text",
          "content": "it must name a live release that has been the platform default or is your organization's canary (GET /plugins/toolchain/eligible lists them), else TOOLCHAIN_RELEASE_NOT_ELIGIBLE. A pipeline whose pinned release was later yanked still saves for unrelated edits."
        },
        {
          "type": "list",
          "items": [
            "Exact selection keeps working. A yanked, deprecated or never-promoted pin"
          ]
        },
        {
          "type": "text",
          "content": "still resolves, and pipeline synth prints its warning (TOOLCHAIN_RELEASE_YANKED, _DEPRECATED, _INACTIVE, _NOT_PROMOTED, Error handling). A deleted one is a 404 and the synth stops with BOOTSTRAP_IMAGE_UNRESOLVED."
        },
        {
          "type": "list",
          "items": [
            "Templates never carry a pin. Saving a template strips toolchain, and"
          ]
        },
        {
          "type": "text",
          "content": "instantiating one ignores it."
        },
        {
          "type": "list",
          "items": [
            "The org's default (Settings → Organization → Pipelines → Pipeline toolchain,"
          ]
        },
        {
          "type": "text",
          "content": "toolchain:manage) applies to every pipeline that does not pin — see Organization Benefits → Pipeline toolchain default."
        },
        {
          "type": "text",
          "content": "Upgrading the CLI inside the synth step. By default the cdk-synth step runs the pipeline-manager baked into its release. To run a newer CLI without waiting for a new release, opt in on the synth step's env:"
        },
        {
          "type": "code",
          "content": "{\n  \"plugin\": { \"name\": \"cdk-synth\" },\n  \"env\": {\n    \"PIPELINE_MANAGER_UPGRADE\": \"true\",           // default \"false\"\n    \"PIPELINE_MANAGER_UPGRADE_VERSION\": \"4.5.3\"   // optional: semver or dist-tag; default \"latest\"\n  }\n}",
          "language": "jsonc"
        },
        {
          "type": "text",
          "content": "With only PIPELINE_MANAGER_UPGRADE set (or the version blank or latest), the step runs a bare pipeline-manager --upgrade before synthesizing: the latest release, and never a move backwards if the baked CLI is already newer. Any other version is passed as --upgrade <version> and installed as named, downgrade included. Either way it runs with every check described under Upgrading, including the registry signature. Any refusal or failure fails the step, and a value other than true or false is rejected. With it on, the step no longer runs the CLI the release records, so release and canary data describe a CLI it didn't use. Pin a version rather than latest if you need repeatable synths."
        },
        {
          "type": "list",
          "items": [
            "Escape hatch. The raw aws:cdk:codebuild:buildenvironment:buildimage"
          ]
        },
        {
          "type": "text",
          "content": "metadata key still overrides the image per step."
        },
        {
          "type": "text",
          "content": "Recovering a pipeline on a bad release. Deployed pipelines pull the release they were synthesized with by digest, so a yank changes nothing until the next synth. To move one:"
        },
        {
          "type": "list",
          "items": [
            "Change (or remove) its toolchain.release pin — or, for unpinned pipelines,"
          ]
        },
        {
          "type": "text",
          "content": "change the org default or follow the platform default."
        },
        {
          "type": "list",
          "items": [
            "Re-run the pipeline, or pipeline-manager pipeline deploy it, so the next"
          ]
        },
        {
          "type": "text",
          "content": "synth resolves the new release. Self-mutation runs on the AWS curated image, so it is never stuck on the bad one."
        },
        {
          "type": "list",
          "items": [
            "A pipeline whose synth step itself can't run on the bad release can't heal"
          ]
        },
        {
          "type": "text",
          "content": "itself: redeploy it from a workstation with pipeline-manager pipeline deploy --id <pipelineId> (or --local-spec with a --toolchain-file exported for a good release)."
        },
        {
          "type": "text",
          "content": "Local-spec deploys. pipeline deploy --local-spec never contacts the platform, so it takes the release from a file:"
        },
        {
          "type": "code",
          "content": "pipeline-manager toolchain export --output toolchain.json\n\npipeline-manager pipeline deploy --local-spec pipeline.json --toolchain-file toolchain.json",
          "language": "bash"
        },
        {
          "type": "text",
          "content": "The file's platform host becomes the registry pull host (unless IMAGE_REGISTRY_PULL_HOST is set). A pipeline that pins toolchain.release must be given that release's export."
        },
        {
          "type": "text",
          "content": "Only the managed cdk-synth comes from --toolchain-file. A local-spec deploy looks up no other plugin, and every plugin must resolve before synth, so each stage plugin (and a synth plugin other than cdk-synth) must already be in the spec's resolvedPlugins, keyed by its alias. A plugin that isn't there fails the synth naming the plugin and the step."
        },
        {
          "type": "text",
          "content": "Pipeline stack names"
        },
        {
          "type": "text",
          "content": "pipeline synth / pipeline deploy name the CloudFormation stack after the pipeline's project and organization, and record the same name in the registry, so the deployed stack and its registry row always agree (pipelineStackName in src/config/cli.constants.ts):"
        },
        {
          "type": "list",
          "items": [
            "Plain name — <project>-<organization>, lowercased — only when the"
          ]
        },
        {
          "type": "text",
          "content": "organization contains no hyphen and the result already meets CloudFormation's rule (starts with a letter; letters, digits and - only; at most 128 characters): spring-boot / system → spring-boot-system. The hyphen rule keeps the name unambiguous: a-b / c and a / b-c would otherwise both be a-b-c."
        },
        {
          "type": "list",
          "items": [
            "Otherwise a sanitized base plus -<hash>. Every disallowed character"
          ]
        },
        {
          "type": "text",
          "content": "becomes -, a leading non-letter gets pb-, the base is truncated to fit, and -<8 hex> of the raw pair (pipelineIdentityDigest: sha256 of the lowercased [project, organization]) is appended: my.app / acme → my-app-acme-<hash>, spring_boot / system → spring-boot-system-<hash>. The hash keeps rewritten names distinct from each other and from every plain name."
        },
        {
          "type": "text",
          "content": "Only the stack name is derived; project and organization keep their values everywhere else."
        }
      ]
    },
    {
      "id": "configuration",
      "title": "Configuration",
      "blocks": [
        {
          "type": "list",
          "items": [
            "Install the CLI — see Install.",
            "Sign in, or set a token. pipeline-manager auth login for a person; PLATFORM_TOKEN for CI, which takes precedence over a stored session everywhere.",
            "Point it at your platform with the base URL, and at AWS with a region — precedence is documented in Configuration precedence.",
            "For installs, start with infra provision --json to inspect the plan before anything runs.",
            "Add --yes for non-interactive CI, and expect AWS teardowns to still demand the typed stack/cluster id unless you also pass --force.",
            "Wire CI on the exit codes rather than on non-zero alone."
          ]
        }
      ]
    },
    {
      "id": "install",
      "title": "Install",
      "blocks": [
        {
          "type": "code",
          "content": "npm install -g @pipeline-builder/pipeline-manager",
          "language": "bash"
        },
        {
          "type": "text",
          "content": "Requires Node.js 26.13+ (any 26.13 patch or newer). The binary is exposed as pipeline-manager."
        },
        {
          "type": "code",
          "content": "pipeline-manager --help            # global help\npipeline-manager <command> --help  # full flag reference for any command\npipeline-manager version           # CLI version info",
          "language": "bash"
        },
        {
          "type": "text",
          "content": "Upgrading"
        },
        {
          "type": "code",
          "content": "pipeline-manager --upgrade                # move to the latest release\npipeline-manager --upgrade 4.4.22         # move to a specific version (or a dist-tag), downgrades included\npipeline-manager --upgrade-check          # only report: exit 0 = current, 1 = a newer release exists",
          "language": "bash"
        },
        {
          "type": "text",
          "content": "--upgrade is available from 4.4.21. An older install needs one manual npm install -g @pipeline-builder/pipeline-manager first."
        },
        {
          "type": "text",
          "content": "No sign-in needed. --upgrade and --upgrade-check talk only to the npm registry, never to the platform. They read no stored session or token and work signed out, so a CLI too old to sign in can still upgrade itself."
        },
        {
          "type": "text",
          "content": "It reinstalls the CLI with the package manager that owns it (npm or pnpm, global). It uses the npm that belongs to the running Node, not whichever one is first on PATH. Before installing, it checks:"
        },
        {
          "type": "list",
          "items": [
            "Ownership. The running copy must be a global npm or pnpm install. It refuses (exit 8) for npx, a project dependency, a source checkout or Volta, because reinstalling globally would leave that copy unchanged. Update those with whatever installed them.",
            "Direction. A bare --upgrade never moves backwards. Naming a version is how to downgrade, but not below 4.4.21, which would leave no --upgrade to come back with.",
            "Node. The target's engines.node must accept the running Node.",
            "Permissions. The global directory must be writable, checked before anything is downloaded. If it isn't, the CLI prints the one command that needs root (sudo npm install -g @pipeline-builder/pipeline-manager@<version>) or how to move npm globals into your home directory. It never suggests sudo pipeline-manager, which would run the whole CLI, including its credential store, as root.",
            "Signature. It downloads the release with npm pack. It checks that the tarball's sha512 matches the registry's dist.integrity and that npm's ECDSA signature over it verifies. Then it installs that tarball. npm's signing keys always come from https://registry.npmjs.org/-/npm/v1/keys, even when a mirror is configured: a mirror passes npm's signatures through, so it can't substitute its own key. With no route to registry.npmjs.org it fails closed. Set PIPELINE_MANAGER_UPGRADE_SKIP_VERIFY=1 to install unverified."
          ]
        },
        {
          "type": "text",
          "content": "Afterwards it reads the installed version back from disk and prints a link to the changes between the two releases."
        },
        {
          "type": "table",
          "headers": [
            "Exit",
            "Meaning"
          ],
          "rows": [
            [
              "0",
              "upgraded, or already current"
            ],
            [
              "1",
              "the download failed verification, or the version on disk is not the target (for --upgrade-check: a newer release exists)"
            ],
            [
              "2",
              "not a semver or dist-tag, no such version or tag, or a version below 4.4.21"
            ],
            [
              "7",
              "the registry could not be reached"
            ],
            [
              "8",
              "not a global npm/pnpm install, or the target needs a newer Node"
            ],
            [
              "9",
              "the global directory is not writable, or the install failed; the old version is still installed"
            ]
          ]
        },
        {
          "type": "text",
          "content": "Update notice. Once a day, a detached background process asks the registry for the latest release; no command ever waits on it. When a newer release is known, the CLI prints Update available … run pipeline-manager --upgrade to stderr on exit. It stays silent in CI (CI set), when stderr is not a terminal, under --quiet / --token, and when PIPELINE_MANAGER_NO_UPDATE_CHECK=1 is set. The cache lives in ~/.pipeline-manager/update-check.json."
        },
        {
          "type": "text",
          "content": "Minimum CLI version (operators). Every platform call carries X-Pb-Client-Version. If PIPELINE_MANAGER_MIN_VERSION is set on the services (docker-compose passes it through x-common-env; in Kubernetes, add it to each service's env), an older CLI gets 426 CLIENT_UPGRADE_REQUIRED with \"run: pipeline-manager --upgrade\". Requests without the header pass: browsers, other clients and CLIs from before 4.4.21. A malformed value stops the service from starting."
        },
        {
          "type": "list",
          "items": [
            "CI is never refused. A request carrying X-CodeBuild-Build-Id runs the CLI baked into a plugin image, which doesn't upgrade itself unless the synth step opts in (Upgrading the CLI inside the synth step). So it is counted (caller=\"ci\") but never refused. Raising the minimum therefore can't break pipelines; their images move when the plugin is rebuilt.",
            "A compatibility check, not a security control. The version header is set by the caller: a CLI can omit it or claim any version. Never use the minimum to shut out a CLI with a security flaw; revoke its tokens instead.",
            "An older CLI gets exit code 8 from a 426, the same as a local configuration problem, so scripts can tell it apart."
          ]
        },
        {
          "type": "text",
          "content": "Before raising the minimum, check what is still calling. pipeline_manager_requests_total{version} counts requests per CLI version whether or not a minimum is set. Versions are reduced to x.y.z, and past 64 distinct values per process new ones count as other, because the header arrives before authentication. pipeline_manager_upgrade_required_total{version,min} counts the 426s. Audit rows record the CLI as details._context.clientVersion, as the caller claimed it. Each access key records the CLI version it was last used with (lastClientVersion), and Settings → Access keys shows it under Last used. An org admin can see which members' keys and service accounts still run an old CLI before the minimum goes up."
        },
        {
          "type": "text",
          "content": "Prerequisites for local pipeline deploys"
        },
        {
          "type": "text",
          "content": "pipeline synth / pipeline deploy run the AWS CDK CLI, so cdk must be on PATH; they check for it and stop with the fix if it's missing. Nothing is bundled on your machine and nothing is deployed to look plugins up — every plugin is resolved by the CLI before synth — so neither esbuild, pnpm nor Docker is needed. Install the CDK CLI version the pipeline-bootstrap image bakes in (its toolchain in deploy/toolchain/pipeline-bootstrap/plugin-spec.yaml):"
        },
        {
          "type": "code",
          "content": "npm install -g aws-cdk@2.1148.1",
          "language": "bash"
        },
        {
          "type": "text",
          "content": "In CodeBuild this is handled for you — the bootstrap image ships the CDK CLI (see AWS deployment → the managed toolchain release)."
        }
      ]
    },
    {
      "id": "quick-start",
      "title": "Quick start",
      "blocks": [
        {
          "type": "code",
          "content": "pipeline-manager auth login --url https://platform.example.com\n\nexport PLATFORM_TOKEN=$(pipeline-manager auth login --token)\n\npipeline-manager infra bootstrap --account 123456789012 --region us-east-1\n\npipeline-manager pipeline create -f props.json\n\npipeline-manager pipeline synth --id <pipelineId>\n\npipeline-manager pipeline deploy --id <pipelineId>",
          "language": "bash"
        }
      ]
    },
    {
      "id": "installing-the-platform-infra-provision",
      "title": "Installing the platform (infra provision)",
      "blocks": [
        {
          "type": "text",
          "content": "infra provision is the recommended way to stand up the platform (not a pipeline). It runs prerequisite checks, assembles the exact bin/setup.sh command (secrets masked, missing inputs reported — never guessed), shows the plan, and deploys it end-to-end, gated by confirmation prompts."
        },
        {
          "type": "code",
          "content": "pipeline-manager infra provision --target docker\n\npipeline-manager infra provision --target docker --json\n\npipeline-manager infra provision --target eks \\\n  --domain pipeline.example.com --hosted-zone-id Z123 --ghcr-token ghp_xxx --email\n\npipeline-manager infra provision --target eks --teardown\n\npipeline-manager infra provision --target docker --repo --yes \\\n  --admin-email admin@acme.com --admin-password 's3cret'\n\npipeline-manager infra provision --target docker --repo --with-all --with-smoke-test",
          "language": "bash"
        },
        {
          "type": "text",
          "content": "What infra provision handles"
        },
        {
          "type": "list",
          "items": [
            "Deploy (gated) or teardown. It shows the plan, then deploys — refusing on failed prerequisites or missing inputs, confirming before it runs (--yes auto-accepts for CI), then verifying health and running init-platform. --json prints the plan and runs nothing. --teardown removes a deployment: docker/minikube stop the stack; EC2 deletes its CloudFormation stack and EKS runs bin/shutdown.sh (cluster + EFS + ACM + Route 53), both irreversibly and require typing the stack/cluster id to confirm (--force skips it for CI).",
            "Prerequisites, handled. The checks mirror each target's setup.sh exactly — local: Docker, Docker Compose, yq, openssl; minikube: Docker, minikube, kubectl, openssl (+ yq with --with-plugins); ec2: AWS CLI + working credentials; eks: AWS CLI + credentials, kubectl, openssl, envsubst (+ yq with --with-plugins). eksctl is auto-installed by setup.sh when not on PATH. Missing single-binary tools (yq, kubectl, minikube) are offered as an on-demand fetch into ~/.pipeline-manager/tools and put on PATH — no brew/apt, no system change. For local/minikube it also creates the target's .env from .env.example, generating the CHANGE_ME secrets.",
            "Self-healing. On a failed deploy it matches known CloudFormation issues (cause + fix) and can auto-fix + retry a few — e.g. an existing SES identity → re-run with --skip-ses-identity. Gated and bounded by --retries (the scripts are idempotent, so a re-run resumes).",
            "AI-optional. Set ANTHROPIC_API_KEY (or AI_PROVIDER + its key) to parse a natural-language --prompt and add free-form failure diagnosis; without a key it falls back to the deterministic issue matcher.",
            "Bootstrap a fresh machine (--repo). Without a checkout, --repo git-clones the platform repo first, then runs from it. The clone is sparse + partial (--filter=blob:none + cone sparse-checkout, git ≥ 2.27 — else a full-clone fallback): it materializes only the deploy folders the selected target + options need. Re-syncs are additive — a single --workdir can accumulate multiple targets. Override with --repo <url>, --ref <branch|tag>, --workdir <dir>.",
            "Run in Docker, zero host installs. deploy/bin/provision-docker.sh runs infra provision inside a throwaway node:26-slim container, installing only the tools the chosen target needs. Args pass straight through. (On macOS the container can't drive Docker Desktop's CLI, so run local on the host instead — the wrapper shines for the AWS targets.)",
            "Post-install steps. After deploy + health, infra provision registers the admin (non-interactive with --admin-email/--admin-password) and runs opt-in loads — passed as flags or offered interactively after the clone when none are given: --with-plugins (adds deploy/plugins), --with-compliance, --with-samples, --with-all, --with-smoke-test, --with-events (AWS event ingestion: three infra store-token runs write the platform, registry:push and reporting:ingest service-account keys to Secrets Manager, then infra setup-events --scoped-ingest deploys the EventBridge → SQS → Lambda), and repeatable --post-step \"<cmd>\". Default is register-only; --init skip skips even that. All steps are idempotent."
          ]
        },
        {
          "type": "text",
          "content": "The underlying bin/setup.sh / bin/shutdown.sh scripts (and aws cloudformation delete-stack for ec2) remain the source of truth and can always be run directly. Full guide: AWS deployment → AI-assisted install."
        }
      ]
    },
    {
      "id": "command-reference",
      "title": "Command reference",
      "blocks": [
        {
          "type": "text",
          "content": "Run pipeline-manager <command> --help for the full flag reference on any command."
        },
        {
          "type": "text",
          "content": "Platform installation"
        },
        {
          "type": "table",
          "headers": [
            "Command",
            "Purpose"
          ],
          "rows": [
            [
              "infra provision",
              "Install (or tear down) the platform on local/Minikube/EC2/EKS: prereq checks + assembles the exact bin/setup.sh command, then deploys it (gated by confirmation; --yes for CI, --json to print the plan and run nothing), verifying health + running post-install steps. --repo bootstraps a fresh machine via a sparse clone; --with-*/--post-step add post-install steps; --teardown removes it. On failure it diagnoses + auto-fixes/retries known issues."
            ]
          ]
        },
        {
          "type": "text",
          "content": "Project lifecycle"
        },
        {
          "type": "table",
          "headers": [
            "Command",
            "Purpose"
          ],
          "rows": [
            [
              "infra bootstrap",
              "Deploy the AWS CDK toolkit stack in the target account/region (--account, --region, --qualifier, --trust for cross-account deploys, --cloudformation-execution-policies) — needed once per account/region before the first pipeline deploy there. It scaffolds nothing: a pipeline definition comes from template instantiate + pipeline create"
            ],
            [
              "pipeline synth",
              "Run CDK synth to emit the CloudFormation template for the pipeline"
            ],
            [
              "pipeline deploy",
              "Deploy the synthesized pipeline stack to AWS (also registers the pipeline with the platform by its pipelineId; a pipeline deployed without this command registers itself on its first pipeline event, see DORA metrics → Registration). --local-spec <pipeline.json> deploys a local spec without contacting the platform; it requires --toolchain-file <path> (see below) and refuses with BOOTSTRAP_IMAGE_UNRESOLVED without one. With --id, `--remediation-upgrades <inherit\\",
              "off\\",
              "propose\\",
              "apply> sets the pipeline's plugin security fixes election on the platform before deploying (a PUT, so the credential needs pipelines:write; refused with --local-spec`)"
            ],
            [
              "toolchain export",
              "Write the pipeline toolchain release as JSON: the release your organization resolves to now (its own default, a canary, or the platform default), or --release <V>. It holds both halves' (pipeline-bootstrap, cdk-synth) image repositories and signed digests, the release version and its tool versions, and the platform it came from. --output <file> (default stdout). Read-only. The input to pipeline deploy --local-spec --toolchain-file"
            ],
            [
              "pipeline register",
              "Re-register a deployed pipeline and drain pending intents queued by prior failed deploys (recovery path; exits non-zero if any registration still fails)"
            ],
            [
              "pipeline deregister",
              "Remove one pipeline_registry row by its registry id (--id, --yes required). The fix audit stacks prints for a missing-stack finding (a row whose stack was deleted out of band)"
            ],
            [
              "pipeline delete",
              "Delete a pipeline definition (--id, --yes required). It does not touch AWS — a deployed stack keeps running and shows up in audit stacks as orphaned until destroyed"
            ],
            [
              "pipeline run",
              "Start a deployed pipeline with your own AWS credentials (--id, optional --region / --profile, --json). The platform is asked only where the pipeline is (its registry row); the CLI then reads the CodePipeline's pb.pipeline-id tag and refuses unless it equals --id, and starts it with a fresh clientRequestToken. Region: --region, else the region recorded at deploy, else AWS_REGION / AWS_DEFAULT_REGION / CDK_DEFAULT_REGION / the profile's region. For teams that want no runner at all"
            ],
            [
              "pipeline deploy-job",
              "Hidden; not for people. What a runner's CodeBuild deploy project runs (the inline buildspec calls pipeline-manager pipeline deploy-job --result-file … inside the pipeline's managed cdk-synth image). It decrypts the KMS-wrapped grant, exchanges it for a session scoped to that one deploy, fetches the pipeline, runs the prechecks (CDK bootstrap version, the secrets the pipeline needs, ownership of an existing stack of that name, cleaning this pipeline's own failed first deploy), synthesizes and deploys it, registers it and reports a result code from a fixed list. --protocol prints the deploy-job protocol the image speaks (the platform refuses a toolchain release that records an older one with TOOLCHAIN_TOO_OLD_FOR_DEPLOY). It takes everything from its PB_* environment and refuses to run outside a deploy build. See Deploying a pipeline through a runner"
            ],
            [
              "pipeline stop",
              "Stop a running execution with your own AWS credentials (--id, --execution <id>, optional --abandon, --reason). Same tag check as pipeline run, and the execution must belong to that pipeline"
            ],
            [
              "status",
              "Show the CLI's setup — not a deployment: the platform it talks to, the credential it would use and when it expires, whether the platform accepts it (GET /api/user/profile, with who and which org), CDK availability and /health reachability"
            ]
          ]
        },
        {
          "type": "text",
          "content": "Resource management"
        },
        {
          "type": "table",
          "headers": [
            "Command",
            "Purpose"
          ],
          "rows": [
            [
              "pipeline create",
              "Register a new pipeline definition with the platform (--upsert overwrites the pipeline already in that project/organization; --deploy deploys it right after). `--remediation-upgrades <inherit\\",
              "off\\",
              "propose\\",
              "apply>` sets its plugin security fixes election — see Plugin security fixes from the definition"
            ],
            [
              "pipeline list / pipeline get",
              "Inspect pipelines registered to your organization"
            ],
            [
              "plugin list / plugin get",
              "Browse the plugin catalog and fetch a single plugin spec"
            ],
            [
              "plugin new",
              "Scaffold a plugin FROM a plugin-<eco>-base image (--base, list them with --list-bases): a Dockerfile that follows the catalog rules, a plugin-spec.yaml with catalog metadata (summary, description, version 0.1.0, category, license, smokeTest, optional curated --icon, a changelog entry), README.md and LICENSE. It passes plugin validate and test-plugins.sh as generated. See Authoring a plugin"
            ],
            [
              "plugin validate",
              "Validate a local plugin directory with the server's schemas (the spec and config schemas and the {{ ... }} contract, shared from api-core), then report every catalog field: its value, where it would come from (spec, README, Dockerfile label or generated) and whether it would be empty or invalid. --lint adds the catalog's Dockerfile rules; --json prints the report. Exits non-zero on any problem (CI-friendly)"
            ],
            [
              "plugin test",
              "Run the plugin's install and build commands locally in its image (built from the plugin's Dockerfile, or --image) against a sample --workspace, as the image's non-root user, with the spec's env and --metadata / --var / --env values. Secrets are passed from your environment by name and never printed. It applies failureBehavior, checks that primaryOutputDirectory exists and is not empty, runs the smokeTest, and exits non-zero on any failure"
            ],
            [
              "plugin publish",
              "Pre-flight (plugin validate --lint), a local scan preview (syft SBOM + grype, when installed), the accept-or-edit step for the detected catalog metadata, then one upload with visibility=public and publishRequest=true. --yes accepts everything detected, --metadata <file.yaml> supplies edits without prompting, and --dry-run uploads nothing. See Plugin Publishing"
            ],
            [
              "plugin upload",
              "Upload a custom plugin package (--file <zip>) to the platform. The name and version always come from the package's plugin-spec.yaml and the organization from your session; --public uploads it as public (needs plugins:publish, otherwise it is org), --dry-run checks the file without uploading"
            ],
            [
              "plugin deprecate",
              "Deprecate one plugin version (--id, optional --message shown to its users). It keeps resolving, but synth warns, AI suggestions skip it, and orgs whose pipelines use it are notified. --undo clears it"
            ],
            [
              "plugin yank",
              "Yank one plugin version (--id, required --reason): ranges, latest and the default stop resolving to it; exact pins still resolve with a warning. Yanking the default promotes the next version. A version published to the ecosystem is refused (409)"
            ],
            [
              "plugin verify",
              "Report, at run time, what the platform now knows about a pipeline's pinned plugin images (a CVE, a KEV listing or a policy change since the synth): --pipeline-id, plus --manifest <pb-step-manifest.json> or --steps-file <json>; --store-tokens in CodeBuild. Vulnerability state is reported, never enforced — it exits 0 whatever the verdict, and warns and exits 0 when the check cannot run unless --strict. The synthesized pipeline runs it per stage when aws:cdk:operations:runtimevulncheck is on. --json for scripts"
            ],
            [
              "security-report upload",
              "Upload one scan report produced inside a pipeline (--pipeline-id, --file, --tool, `--format sarif\\",
              "trivy-json\\",
              "grype-json, optional --execution-id (default PIPELINE_EXECUTION_ID) and --stage; --store-tokens` in CodeBuild), so its findings land on the platform beside the plugin-image findings"
            ],
            [
              "template instantiate",
              "Render a golden-path pipeline template into concrete pipeline props — resolve it by --name (or --id), supply its declared inputs with repeatable --input k=v / --inputs-file, and write the result to --output (or stdout). Creates nothing: feed the props to pipeline create --file, which is where compliance and quota apply"
            ],
            [
              "template validate",
              "Parse and validate {{ ... }} templates in a pipeline or plugin spec (local file, registered pipeline by ID, or registered plugin by name:version)"
            ],
            [
              "org export",
              "Export an organization's data as JSON for GDPR portability (sysadmins can export any org; org admins their own only). Needs a fresh step-up: like auth pat, it shows a device code to approve in the browser (--no-browser prints the URL instead). To export an org you manage that isn't your default, add --org <orgId>. If the platform could not read some stores, the file is still written (0600) but the CLI warns the export is INCOMPLETE and exits 3 (API_REQUEST)"
            ]
          ]
        },
        {
          "type": "text",
          "content": "Auth & infrastructure"
        },
        {
          "type": "table",
          "headers": [
            "Command",
            "Purpose"
          ],
          "rows": [
            [
              "auth login",
              "Sign in through your browser using the OAuth 2.0 device authorization grant (RFC 8628): the CLI prints a short code, you approve it in the browser (where SSO and step-up already apply), and the session is stored in ~/.pipeline-manager/credentials.json. --org <orgId> switches organization afterwards; --no-browser prints the URL instead of opening it. --token prints the access token and nothing else, for export PLATFORM_TOKEN=$(pipeline-manager auth login --token) — everything else, including the approval code, goes to stderr so the capture stays clean. There is no password flag and no way to pass a refresh token"
            ],
            [
              "auth logout",
              "Sign this device out: revoke the stored session on the platform (POST /api/auth/logout, renewing an expired access token first) and delete it from ~/.pipeline-manager/credentials.json. The local copy is always removed; when the platform can't be reached the command says so, and the device is then revoked from Settings → Sessions and devices. PLATFORM_TOKEN and access keys are untouched"
            ],
            [
              "auth pat",
              "Create a named access key (pb_pat_…) for CI. Uses the same browser sign-in, and the approval doubles as the step-up the platform requires to create a key — so no password is typed here either. The key is printed once"
            ],
            [
              "infra store-token",
              "Provision the org's machine identity — a service account plus one pb_sa_… key — and store the key in AWS Secrets Manager (read by CodeBuild's registry credentials, the events Lambda and --store-tokens). Add --schedule to also deploy a daily key-rotation stack (rotate → store → revoke; --cron <5-field expr>, default TOKEN_RENEW_SCHEDULE or 0 0 * * *) so the key never lapses. Each secret gets its own rotation stack, pipeline-builder-token-renew-<leaf>-<hash> (<leaf> is the secret name's last path segment, <hash> the first 8 hex of the sha256 of the full secret name; the Lambda is named the same), so every scope's stack, and another org's with the same leaf in the same account, coexists. Re-run per scope (--scope reporting:ingest, --scope registry:push) — each is its own least-privilege account. With PLATFORM_SECRET_NAME set, the platform key is written to exactly that name and a --scope key to its sibling (…/registry-push, …/reporting-ingest), so running every scope in one shell never overwrites the platform secret. --expires-days sets the key lifetime (default 30, max 365). --dry-run prints the plan without signing in or calling the platform. Both writes (account and key) are step-up gated: `--step-up auto\\",
              "password\\",
              "totp\\",
              "browser (auto uses PLATFORM_PASSWORD/-p when set, else browser approval; a non-interactive run needs the password). An account with no password can issue the key in the web UI and pass it with --from-key <file\\",
              "->` instead"
            ],
            [
              "infra setup-runner",
              "Install a pipeline runner in the AWS account your credentials point at. Runners are the only way the platform starts and stops pipelines (Run and Stop in the dashboard, plugin-upgrade redeploys), and the platform holds no AWS access to any account; every org can install them, with no feature flag. One runner per AWS account per organization: the command lists the account's runner stacks in every enabled region of the account (EC2 DescribeRegions, opt-in regions not opted into excluded; all regions read in parallel, the stack region and --regions must be readable, any other unreadable region, such as one an SCP denies, is warned about and skipped; the credentials need ec2:DescribeRegions and cloudformation:ListStacks / DescribeStacks) and reads each one's RUNNER_ID, refuses a second runner of your org there (update the existing one instead: same --label and --region), and installs beside another org's runner with a warning that a shared AWS account is a shared trust boundary (anyone with AWS access there can reach both orgs' pipelines), recommending distinct --pipeline-prefix values per org. If a parent organization's shared runner is already in the account, it warns that the team already reaches it and asks first (--yes to skip). It registers a pending runner (step-up), deploys pipeline-builder-runner-<runnerId> (the label is kept as the stack tag pb.runner-label) once with that runner's id, then sends the endpoint (a Lambda Function URL, or with --api-gateway --allow-ip <cidr>... an API Gateway that admits only the platform's egress IPs, rate-limited per source IP by an AWS WAF web ACL: --waf-rate-limit <n> requests per 5 minutes, default 1000, or --no-waf to leave it out) to the platform (step-up), which pings it and activates it on pong. --regions <csv> (default: the stack region) and --pipeline-prefix <csv> (default: your org's prefix, from its registered pipeline names) are the runner's local allowlist and scope its IAM role; --pipeline-prefix '*' covers every pipeline and requires --yes. It warns when the region has no pipeline-builder-events stack; --with-events runs infra setup-events --scoped-ingest afterwards. It prints the deployed bundle's SHA-256. Re-running updates the stack in place (and finishes a pending install). --delete finds the runner by the same all-region scan, revokes it on the platform, then deletes the stack (re-run with the --region it names if its stack is in another region; with no stack of it in any enabled region of the account it revokes only a still-pending runner of that label). --dry-run prints the plan and the exact IAM without calling AWS or the platform; --json for scripts. The endpoint URL is never printed. After registering it prints the runner's own JWKS URL (<platform>/api/pipelines/runner/runners/<runnerId>/jwks.json). The org's signing key is checked before anything is created. An org with no key gets one when its first runner registers: its own key for a top-level org or a team using its own key, or the parent's key for a team that inherits it. --generate-key generates the org's own key first (same step-up). Updating an existing runner when there is no key is refused: generate one under Settings → Organization → Pipelines → Pipeline runners, or, for an inheriting team, ask the parent's admins or switch to its own key. An unreadable key is refused. --enable-deploy also lets the runner deploy never-deployed pipelines into this account from the dashboard: it sets the stack's EnableDeploy parameter, adding the CodeBuild project pipeline-builder-runner-deploy-<runnerId> (always unprivileged), its role pb-runner-deploy-<runnerId> (which can only assume the account's CDK bootstrap roles in the allowlisted regions) and a KMS key that wraps each deploy's single-use grant; the runner's next pong reports the deploy:1 capability. It refuses without the registry pull credential (infra store-token --scope registry:push --region <stack-region>) and checks the CDK bootstrap (version 21 or later) in every allowlisted region: it warns about a missing or outdated one, --require-bootstrap refuses instead, and --bootstrap runs infra bootstrap for the missing regions. Deploy options: --cdk-qualifier <q> (default hnb659fds), --deploy-timeout <minutes> (60, 10–480), --deploy-concurrency <n> (2), --deploy-permissions-boundary <arn>, --registry-pull-host <host[:port]>. Re-running without --enable-deploy turns deploys off again. See Cross-account pipeline runner"
            ],
            [
              "`runner signing-key status\\",
              "generate\\",
              "rotate\\",
              "finish`",
              "Your organization's runner signing key, for scripts and settings-as-code; the same routes as the Signing key card in Settings → Organization → Pipelines → Pipeline runners. status shows the mode (own or inherited), the active, next and retiring key ids with their dates, and any rotation in progress. generate creates the first key (active at once; 409 if one exists), rotate publishes a new key that starts signing about 10 minutes later, and finish retires the old key once its hour is up. Every write needs org_settings:write, an MFA-grade session and step-up (`--step-up auto\\",
              "password\\",
              "totp\\",
              "browser, -p/PLATFORM_PASSWORD), and is limited to 5 per org per hour. Only key ids and dates are ever printed; the key pair never leaves the platform. --json` for scripts. See secret rotation"
            ],
            [
              "infra setup-events",
              "Deploy the EventBridge → SQS → Lambda stack that streams CodePipeline events into the platform's reporting service. Add --with-dora to also resolve source commit timestamps in-account for measured commit→deploy lead time — off by default (why: it adds an SCM call + a github-token-secret read per deploy event, so only worthwhile for orgs on the advanced_reporting add-on; the other DORA metrics work without it and lead time simply reports unknown). Re-run to toggle."
            ],
            [
              "infra redrive-events",
              "Manual fallback for the events Lambda's self-healing redrive: move dead-lettered CodePipeline events from pipeline-builder-events-dlq back onto the ingestion queue via SQS StartMessageMoveTask. Skips the move when the DLQ is empty or a move task is already running; idempotent ingest prevents double-counting"
            ]
          ]
        },
        {
          "type": "text",
          "content": "Stakeholder reports"
        },
        {
          "type": "text",
          "content": "The add-on's seven verbs. Two jobs the dashboard is the wrong shape for: backfilling a run of past periods (a loop in a shell versus five careful clicks), and unattended operation — a team producing its report from its own scheduler, or gating a publish on a release finishing, needs a command with an exit code."
        },
        {
          "type": "text",
          "content": "Every gate is the server's. The CLI checks nothing and prints a refusal as the server worded it; reports:write covers create and run, reports:publish covers publish and link, and the whole surface needs the stakeholder_reports feature."
        },
        {
          "type": "table",
          "headers": [
            "Command",
            "Purpose"
          ],
          "rows": [
            [
              "report list",
              "This org's saved reports, their schedule, and the pause reason if any."
            ],
            [
              "report create",
              "Save a new scheduled report. The creator owns it — a scheduled run is authorized as the owner, so the API refuses an ownerId here. Timezone and week start fall back to the org's report defaults."
            ],
            [
              "report run",
              "Compose one period into a frozen snapshot. --period 2026-W38 (or 2026-08, 2026-Q3); omit it for the last complete period. --regenerate produces version N+1 rather than returning the existing snapshot unchanged."
            ],
            [
              "report publish",
              "Publish a composed run (--run <id>). Idempotent: two publishes send one report, so a retried script is safe."
            ],
            [
              "report link",
              "Mint an expiring read-only link (--run <id>, --expires-days, --redact-names, which hides project/pipeline names and error text but keeps stage and action names and the numbers). Shown once — only a hash is stored, so a lost link is replaced, not recovered."
            ],
            [
              "report pdf",
              "Download a run as a PDF (--run <id>, --out <file>). Defaults to the file name the server chose, which carries the report title and the revision. Exits non-zero if the instance has no PDF renderer, so a scripted board pack cannot carry on believing it has a file."
            ],
            [
              "report transfer",
              "Hand a report to a new owner (--id, --owner). Future runs compute with their access, which can change what the report contains."
            ]
          ]
        },
        {
          "type": "code",
          "content": "for w in 34 35 36 37 38; do\n  pipeline-manager report run --id \"$DEF\" --period \"2026-W$w\" || break\ndone",
          "language": "bash"
        },
        {
          "type": "text",
          "content": "Operator audits (cron-friendly)"
        },
        {
          "type": "text",
          "content": "These commands report drift and exit non-zero when findings exist — designed to run on a schedule."
        },
        {
          "type": "table",
          "headers": [
            "Command",
            "Purpose",
            "Exit codes"
          ],
          "rows": [
            [
              "audit stacks",
              "Diff the CloudFormation stacks tagged pipeline-builder in ONE region (--region) against your org's pipeline_registry rows for that region — every page of them. Surfaces orphaned stacks (no row) and missing stacks (a row, no live stack), each with the command that fixes it (pipeline deregister, pipeline register or aws cloudformation delete-stack); stacks tagged with another OrgId are skipped. --org <id> audits another org — honoured only for a credential the platform lets list it (a system admin); otherwise the command fails rather than diff the wrong org. --max-pages raises the DescribeStacks safety cap. See drift detection.",
              "0 clean / 1 findings or an incomplete scan / 2 AWS or platform error"
            ],
            [
              "audit tokens",
              "Scan platform tokens in AWS Secrets Manager and flag any expiring within --warn-days (default 7). Run before tokens lapse to avoid silent reporting outages.",
              "0 clean / 1 at-risk / 2 AWS error"
            ]
          ]
        },
        {
          "type": "text",
          "content": "Misc"
        },
        {
          "type": "table",
          "headers": [
            "Command",
            "Purpose"
          ],
          "rows": [
            [
              "completions",
              "Print a shell completion script for bash, zsh, or fish. Source it from your shell profile, e.g. eval \"$(pipeline-manager completions bash)\" in ~/.bashrc (derived from the live command list, so they never drift)"
            ],
            [
              "version",
              "Print CLI version info"
            ]
          ]
        }
      ]
    },
    {
      "id": "exit-codes",
      "title": "Exit codes",
      "blocks": [
        {
          "type": "text",
          "content": "Every command exits 0 on success. On failure the process exits with a standard code derived from the error type (not the command), so scripts and CI can branch on the class of failure consistently. The code is resolved centrally in handleError from the actual error — typed CLI error → HTTP status → Node system-error code → a command-specific fallback for anything unclassifiable."
        },
        {
          "type": "table",
          "headers": [
            "Code",
            "Name",
            "When"
          ],
          "rows": [
            [
              "0",
              "success",
              "Command completed."
            ],
            [
              "1",
              "GENERAL",
              "Unclassified failure (default fallback for non-API commands)."
            ],
            [
              "2",
              "VALIDATION",
              "Bad input — missing/invalid flags, malformed props file, HTTP 400/422."
            ],
            [
              "3",
              "API_REQUEST",
              "Platform API request failed (server 5xx, or the fallback for API commands)."
            ],
            [
              "4",
              "AUTHENTICATION",
              "Not authenticated — HTTP 401 (e.g. expired/missing token)."
            ],
            [
              "5",
              "AUTHORIZATION",
              "Authenticated but not permitted — HTTP 403."
            ],
            [
              "6",
              "NOT_FOUND",
              "Resource missing — HTTP 404 (e.g. unknown pipeline id)."
            ],
            [
              "7",
              "NETWORK",
              "Request never reached the server — DNS/refused/reset, or no HTTP response."
            ],
            [
              "8",
              "CONFIGURATION",
              "Invalid/missing CLI configuration."
            ],
            [
              "9",
              "FILE_SYSTEM",
              "Local file error — ENOENT/EACCES/… (e.g. unreadable props file)."
            ],
            [
              "10",
              "TIMEOUT",
              "Timed out — HTTP 408/504, or ETIMEDOUT."
            ]
          ]
        },
        {
          "type": "text",
          "content": "Codes are defined in src/types/error.ts; the derivation lives in src/utils/error-handler.ts (resolveExitCode). The operator-audit commands keep their own contract instead: exit 1 means \"findings present\" and exit 2 any AWS or platform failure, whatever its type (see Operator audits). org export exits 3 (API_REQUEST) on a partial dump, even though the file is written."
        }
      ]
    },
    {
      "id": "configuration-precedence",
      "title": "Configuration precedence",
      "blocks": [
        {
          "type": "text",
          "content": "The CLI resolves its settings from these layers, lowest to highest precedence:"
        },
        {
          "type": "list",
          "items": [
            "Built-in defaults",
            "User config file — ~/.pipeline-manager/config.yml",
            "Project config file — CLI_CONFIG_PATH, else the config.yml shipped in the CLI package (not the current directory)",
            "The platform auth login signed in to (base URL only) — so auth login --url X is followed by commands that talk to X, where its session is stored. auth login, auth logout and auth pat default --url to the resolved base URL too."
          ]
        },
        {
          "type": "text",
          "content": "Environment variables (PLATFORM_BASE_URL, …) override the resolved config."
        },
        {
          "type": "text",
          "content": "A config file's api.rejectUnauthorized: false turns TLS verification off for a dev platform, like PLATFORM_TLS_VERIFY=false, and is ignored the same way under NODE_ENV=production (with a warning; verification stays on)."
        },
        {
          "type": "text",
          "content": "How commands authenticate, in priority order:"
        },
        {
          "type": "list",
          "items": [
            "PLATFORM_TOKEN — always wins. This is what CI sets, to an access key from auth pat.",
            "The session auth login stored for this platform's base URL, in ~/.pipeline-manager/credentials.json (owner-only, 0600). It carries the access token and its refresh token, so the CLI renews the session itself and you sign in roughly as often as the refresh token's 30-day life requires. A renewal the platform rejects (400/401) forgets the session; an unreachable platform or a 5xx keeps it and reports the error, so a network blip never forces a new browser sign-in.",
            "--store-tokens with PLATFORM_SECRET_NAME — the service-account key in AWS Secrets Manager (infra store-token). A command given --store-tokens never falls back to your personal session."
          ]
        },
        {
          "type": "text",
          "content": "Sign a stored session out with pipeline-manager auth logout, or from the dashboard (Settings → Sessions and devices) — it appears there as a signed-in device like any other."
        },
        {
          "type": "text",
          "content": "Environment variables"
        },
        {
          "type": "table",
          "headers": [
            "Variable",
            "Required",
            "Purpose"
          ],
          "rows": [
            [
              "PLATFORM_TOKEN",
              "No",
              "Access key or token for the platform. Overrides the stored auth login session — set it in CI, leave it unset on a workstation"
            ],
            [
              "PLATFORM_BASE_URL",
              "No",
              "Base URL of your platform. Overrides the platform auth login signed in to and the config files"
            ],
            [
              "AWS_REGION",
              "Yes (for deploy)",
              "Target AWS region for pipeline synth / pipeline deploy / infra provision teardown"
            ],
            [
              "CLI_CONFIG_PATH",
              "No",
              "Project config file path (default: the config.yml shipped in the CLI package)"
            ],
            [
              "UPLOAD_TIMEOUT_MS",
              "No",
              "Override the plugin-upload request timeout (ms)"
            ],
            [
              "PLATFORM_TLS_VERIFY",
              "No",
              "Set to false to skip TLS verification of the platform, for a dev platform on a self-signed certificate (NODE_TLS_REJECT_UNAUTHORIZED=0 counts the same). Ignored in NODE_ENV=production. The one name for this switch: the CLI, the synth and the key-rotation Lambda all read it. Prefer PLATFORM_CA_BUNDLE, which keeps verification on"
            ],
            [
              "ANTHROPIC_API_KEY (or other provider key)",
              "No",
              "Enables infra provision's natural-language --prompt parsing + failure diagnosis"
            ],
            [
              "AI_PROVIDER / AI_MODEL",
              "No",
              "Provider + model for infra provision (anthropic \\",
              "openai \\",
              "google \\",
              "xai \\",
              "bedrock)"
            ]
          ]
        },
        {
          "type": "text",
          "content": "Full reference: Environment Variables."
        }
      ]
    },
    {
      "id": "typical-workflows",
      "title": "Typical workflows",
      "blocks": [
        {
          "type": "text",
          "content": "Stand up a platform and load everything"
        },
        {
          "type": "code",
          "content": "pipeline-manager infra provision --target eks --repo \\\n  --domain pipeline.example.com --hosted-zone-id Z123 --ghcr-token ghp_xxx \\\n  --email --admin-email admin@acme.com --admin-password 's3cret' \\\n  --with-all --with-events --yes",
          "language": "bash"
        },
        {
          "type": "text",
          "content": "Build and ship a pipeline"
        },
        {
          "type": "code",
          "content": "pipeline-manager auth login --url https://platform.example.com\npipeline-manager infra bootstrap --account 123456789012 --region us-east-1   # once per account/region\npipeline-manager pipeline create -f props.json\npipeline-manager pipeline synth --id <pipelineId>\npipeline-manager pipeline deploy --id <pipelineId>\npipeline-manager status",
          "language": "bash"
        },
        {
          "type": "text",
          "content": "Plugin security fixes from the definition"
        },
        {
          "type": "text",
          "content": "A pipeline's plugin security fixes election (whether the nightly plugin CVE remediation may move it onto fixed plugin versions — see Installing plugins) can live in the pipeline definition, next to project and organization:"
        },
        {
          "type": "code",
          "content": "{\n  \"project\": \"web\",\n  \"organization\": \"acme\",\n  \"remediationUpgrades\": \"off\",\n  \"synth\": { \"plugin\": { \"name\": \"cdk-synth\" } }\n}",
          "language": "json"
        },
        {
          "type": "table",
          "headers": [
            "Value",
            "Meaning"
          ],
          "rows": [
            [
              "inherit",
              "Follow the organization's (or team's) setting — the default for a new pipeline"
            ],
            [
              "off",
              "Opt this pipeline out: it is never proposed or moved"
            ],
            [
              "propose",
              "Open a proposal on the pipeline page; nothing moves until someone applies it"
            ],
            [
              "apply",
              "Move the pipeline automatically — only when the organization's default is apply or its root org allows pipelines to choose it"
            ]
          ]
        },
        {
          "type": "list",
          "items": [
            "It is a platform setting, not a synth prop. The CLI lifts it out of the"
          ]
        },
        {
          "type": "text",
          "content": "file before sending the props, so the synthesized template is identical with or without it. (A direct API call sends it at the top level of the create body; inside props it is refused.)"
        },
        {
          "type": "list",
          "items": [
            "--remediation-upgrades wins over the file on pipeline create; both are"
          ]
        },
        {
          "type": "text",
          "content": "checked against the four values above before anything is sent."
        },
        {
          "type": "list",
          "items": [
            "Set → applied on every create/deploy. pipeline create --upsert (and"
          ]
        },
        {
          "type": "text",
          "content": "pipeline deploy --id … --remediation-upgrades, which sets it before deploying) writes it each time, with the dashboard's rules. A change is audited as pipeline.remediation-upgrades.update with before / after; re-sending the stored value records nothing."
        },
        {
          "type": "list",
          "items": [
            "Absent → kept. A definition (and command line) without it leaves the"
          ]
        },
        {
          "type": "text",
          "content": "stored value alone — an election made in the dashboard survives every redeploy and is never reset to inherit."
        },
        {
          "type": "list",
          "items": [
            "apply the organization forbids is refused with"
          ]
        },
        {
          "type": "text",
          "content": "403 PIPELINE_REMEDIATION_APPLY_NOT_ALLOWED; the CLI exits non-zero (exit code 5) and suggests --remediation-upgrades inherit, off or propose. Nothing is created or deployed."
        },
        {
          "type": "code",
          "content": "pipeline-manager pipeline create -f props.json --upsert --remediation-upgrades off\npipeline-manager pipeline deploy --id <pipelineId> --remediation-upgrades propose",
          "language": "bash"
        },
        {
          "type": "text",
          "content": "Start from a golden-path template"
        },
        {
          "type": "code",
          "content": "pipeline-manager template instantiate \\\n  --name react-javascript \\\n  --project react --organization AcmeCorp \\\n  --input orgId=1234abcd-... \\\n  --output pipeline-props.json\n\npipeline-manager pipeline create --file pipeline-props.json --deploy --region us-east-1",
          "language": "bash"
        },
        {
          "type": "text",
          "content": "Pipe it instead of writing a file with --json, which suppresses all decorative output: pipeline-manager template instantiate --name react-javascript -p react -o AcmeCorp --json | jq .stages."
        },
        {
          "type": "text",
          "content": "Author, test and publish a plugin"
        },
        {
          "type": "code",
          "content": "pipeline-manager plugin new --list-bases\npipeline-manager plugin new --name acme-lint --category quality --base node --license MIT\n\npipeline-manager plugin validate --dir ./acme-lint --lint\npipeline-manager plugin test --dir ./acme-lint --workspace ./sample-app --metadata STAGE=dev\npipeline-manager plugin publish --dir ./acme-lint",
          "language": "bash"
        },
        {
          "type": "list",
          "items": [
            "Bases. The Dockerfile starts FROM plugin-<eco>-base (plugin, aws-cli, cpp, dotnet, go, jvm, node, php, python, ruby, rust, trivy). plugin test and the scan preview build it locally, so build the bases first with deploy/bin/build-plugin-images.sh, or pass --image.",
            "Icons. --icon takes a curated key from deploy/plugins/_icons. Curated marks are for Official listings and Verified publishers who own them. A Community listing uploads a raster icon or shows its monogram, so the default is none.",
            "plugin test is red, never green, when anything fails. A step that fails under failureBehavior: fail, a missing or empty primaryOutputDirectory, an image that runs as root, a failed smokeTest, a required secret missing from your environment, or a {{ ... }} value you didn't supply all exit non-zero. warn and ignore behave as they do in the pipeline, and a security-category plugin always runs as fail.",
            "plugin publish never passes silently. Without syft and grype on PATH it prints that the scan preview did not run (the platform still scans after the build). A critical vulnerability, a lint error or a missing license or README stops it before anything is uploaded. Without a terminal it needs --yes or --metadata."
          ]
        },
        {
          "type": "text",
          "content": "Reference an ecosystem plugin"
        },
        {
          "type": "text",
          "content": "A pipeline step can name a plugin by publisher as well as name. The CLI passes publisher through to lookup at synth."
        },
        {
          "type": "code",
          "content": "plugin: { name: trivy }                                                     # own org, parent org, then the Official listing\nplugin: { publisher: acme, name: terraform-plan, filter: { version: '^1' } } # only acme's listing, through your install",
          "language": "yaml"
        },
        {
          "type": "list",
          "items": [
            "A qualified reference resolves only that publisher's listing, and only through an install. Install it first (dashboard → Plugins, or POST /api/plugins/installs). Official listings (pipeline-builder) are installed implicitly.",
            "pipeline create (and every other create or update path) refuses a qualified reference that isn't installed, is blocked by the org's consumption policy or can't resolve, with 400 and the per-step reasons. It also checks the plugin contract of listed versions.",
            "Lookup verifies the image signature (and, for a listing, the signed trust tier and publisher) and returns imageRepository; synth pins <repository>@<digest>. Warnings such as PLUGIN_SHADOWS_LISTING or PLUGIN_SECRETS_WITHHELD are printed.",
            "Every plugin must resolve, or the synth fails. A step never ships without its plugin. pipeline synth looks up every reference, then fails once with every refusal, each naming the plugin and its cause: IMAGE_VERIFICATION_FAILED, PLUGIN_NOT_INSTALLED, PLUGIN_BLOCKED_BY_POLICY, PLUGIN_UNAVAILABLE, PLUGIN_DELETED, PLUGIN_VERSION_NOT_FOUND (an exact pin that does not exist), PLUGIN_NOT_FOUND (nothing matches a range or default reference) or PLUGIN_LOOKUP_FAILED (the lookup got no answer: the platform was unreachable, or it returned an auth or server error). Inside CodeBuild the same codes go on the PB_SYNTH_FAILURE line the execution event carries.",
            "A qualified step's construct id is <publisher>-<name> (when it has no alias) and its default artifact alias is <publisher>-<name>-alias. Unqualified references are unchanged."
          ]
        },
        {
          "type": "text",
          "content": "See Plugin Installing for installs, version policies and the resolution order."
        },
        {
          "type": "text",
          "content": "Run pipelines through a runner"
        },
        {
          "type": "text",
          "content": "Runners are the only way the platform runs pipelines, so install one before the first Run (a pipeline with none answers NO_RUNNER). One runner per AWS account per organization covers every region it lists."
        },
        {
          "type": "code",
          "content": "pipeline-manager infra setup-runner --region us-east-1 --regions us-east-1,eu-west-2 --dry-run   # review the IAM\npipeline-manager infra setup-runner --region us-east-1 --regions us-east-1,eu-west-2 --with-events\npipeline-manager pipeline run  --id <pipelineId> --profile customer-account\npipeline-manager pipeline stop --id <pipelineId> --execution <executionId> --profile customer-account\npipeline-manager infra store-token --scope registry:push --region us-east-1   # the deploy image's pull credential\npipeline-manager infra bootstrap --region us-east-1                           # every allowlisted region (v21+)\npipeline-manager infra bootstrap --region eu-west-2\npipeline-manager infra setup-runner --region us-east-1 --regions us-east-1,eu-west-2 --enable-deploy --require-bootstrap\npipeline-manager infra setup-runner --region us-east-1 --delete\npipeline-manager runner signing-key status\npipeline-manager runner signing-key rotate      # signs in ~10 minutes\npipeline-manager runner signing-key finish      # after the old key's hour is up (the sweep also does it)",
          "language": "bash"
        },
        {
          "type": "text",
          "content": "Schedule drift detection (cron)"
        },
        {
          "type": "code",
          "content": "pipeline-manager audit stacks --region us-east-1 || alert \"stack drift detected\"\npipeline-manager audit tokens --warn-days 14 || alert \"tokens expiring soon\"",
          "language": "bash"
        }
      ]
    },
    {
      "id": "related-documentation",
      "title": "Related documentation",
      "blocks": [
        {
          "type": "list",
          "items": [
            "AWS Deployment — EC2/EKS deploy, post-deploy setup, drift detection",
            "CDK Usage — the PipelineBuilder construct used by bootstrapped projects",
            "API Reference — REST endpoints the CLI calls",
            "Template Syntax — {{ ... }} interpolation validated by template validate",
            "Environment Variables — full configuration reference"
          ]
        }
      ]
    }
  ],
  "sourceDoc": "docs/pipeline-manager.md"
};
