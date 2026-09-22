// GENERATED FROM docs/pipeline-manager.md — DO NOT EDIT.
// Regenerate: npm run generate:help  (see frontend/scripts/generate-help.mjs)
// SOURCE-SHA256: 1f598c1b4ef770ca2fcda03c9646aa34190e74e5602a9a211bfc7a1e476ac377
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
          "content": "pipeline-manager is the command-line interface for Pipeline Builder. It does two jobs:"
        },
        {
          "type": "list",
          "items": [
            "Installs the platform itself — stand up Pipeline Builder on Docker Compose, Minikube, EC2, or EKS (Auto Mode) with the infra provision command.",
            "Manages pipelines and plugins against a running platform — bootstrap a CDK project, synth, deploy, register pipelines, browse the plugin catalog, and run operator audits."
          ]
        },
        {
          "type": "text",
          "content": "The CLI talks to the platform's REST API for resource operations and drives AWS CDK / CloudFormation for deploys."
        }
      ]
    },
    {
      "id": "overview",
      "title": "Overview",
      "blocks": [
        {
          "type": "text",
          "content": "pipeline-manager is the command-line interface for Pipeline Builder, serving both operators who install the platform and developers who manage pipelines against a running one. It talks to the platform's REST API for resource operations and drives AWS CDK / CloudFormation for deploys. This page covers installation, the infra provision installer, the full command reference, configuration precedence, and typical workflows."
        }
      ]
    },
    {
      "id": "process-overview",
      "title": "Process overview",
      "blocks": [
        {
          "type": "text",
          "content": "Two flows, depending on the job:"
        },
        {
          "type": "text",
          "content": "Install the platform"
        },
        {
          "type": "list",
          "items": [
            "npm install -g @pipeline-builder/pipeline-manager.",
            "infra provision --target <docker|minikube|ec2|eks> — prereq checks, plan, gated deploy, health verify, and post-install loads.",
            "Tear down later with infra provision --teardown."
          ]
        },
        {
          "type": "text",
          "content": "Build and ship a pipeline"
        },
        {
          "type": "list",
          "items": [
            "auth login against your platform.",
            "infra bootstrap a CDK project, then pipeline synth.",
            "pipeline deploy to AWS (auto-registers the pipeline); check status, and run audit stacks / audit tokens on a schedule to catch drift."
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
          "content": "Requires Node.js 24.14.0+. The binary is exposed as pipeline-manager."
        },
        {
          "type": "code",
          "content": "pipeline-manager --help            # global help\npipeline-manager <command> --help  # full flag reference for any command\npipeline-manager version           # CLI version info",
          "language": "bash"
        },
        {
          "type": "text",
          "content": "Prerequisites for local pipeline deploys"
        },
        {
          "type": "text",
          "content": "pipeline synth / pipeline deploy (and running cdk deploy directly) synthesize the pipeline stack, which bundles the PluginLookup Lambda via CDK's NodejsFunction (esbuild). pipeline synth/deploy preflight this for you — they check esbuild + pnpm are on PATH and fail fast with the fix below rather than letting the build die deep in an opaque bundling error. (Bypass the check with SKIP_BUNDLER_CHECK=1.) If esbuild isn't on PATH, CDK silently falls back to Docker bundling, which can't resolve the handler's axios / ../config imports and fails with:"
        },
        {
          "type": "code",
          "content": "esbuild cannot run locally. Switching to Docker bundling\n✘ [ERROR] Could not resolve \"axios\"\n✘ [ERROR] Could not resolve \"../config/handler-constants.js\""
        },
        {
          "type": "text",
          "content": "Install esbuild and pnpm (the handler's lockfile is pnpm-lock.yaml, so CDK uses pnpm to run esbuild) — plus the CDK CLI — globally, matching the versions the CodeBuild bootstrap image bakes in:"
        },
        {
          "type": "code",
          "content": "npm install -g esbuild@0.28.1 pnpm@10.33.0 aws-cdk@2.1126.0",
          "language": "bash"
        },
        {
          "type": "text",
          "content": "With esbuild on PATH, NodejsFunction bundles locally (no Docker) and the Lambda resolves correctly. In CodeBuild this is handled for you — the bootstrap image ships these tools (see AWS deployment → CodeBuild bootstrap image)."
        }
      ]
    },
    {
      "id": "quick-start",
      "title": "Quick start",
      "blocks": [
        {
          "type": "code",
          "content": "pipeline-manager auth login --url https://platform.example.com\n\npipeline-manager infra bootstrap\n\npipeline-manager pipeline synth\n\npipeline-manager pipeline deploy",
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
            "Deploy (gated) or teardown. It shows the plan, then deploys — refusing on failed prerequisites or missing inputs, confirming before it runs (--yes auto-accepts for CI), then verifying health and running init-platform. --json prints the plan and runs nothing. --teardown removes a deployment: local/minikube stop the stack; EC2 deletes its CloudFormation stack and EKS runs bin/shutdown.sh (cluster + EFS + ACM + Route 53), both irreversibly and require typing the stack/cluster id to confirm (--force skips it for CI).",
            "Prerequisites, handled. The checks mirror each target's setup.sh exactly — local: Docker, Docker Compose, yq, openssl; minikube: Docker, minikube, kubectl, openssl (+ yq with --with-plugins); ec2: AWS CLI + working credentials; eks: AWS CLI + credentials, kubectl, openssl, envsubst (+ yq with --with-plugins). eksctl is auto-installed by setup.sh when not on PATH. Missing single-binary tools (yq, kubectl, minikube) are offered as an on-demand fetch into ~/.pipeline-manager/tools and put on PATH — no brew/apt, no system change. For local/minikube it also creates the target's .env from .env.example, generating the CHANGE_ME secrets.",
            "Self-healing. On a failed deploy it matches known CloudFormation issues (cause + fix) and can auto-fix + retry a few — e.g. an existing SES identity → re-run with --skip-ses-identity. Gated and bounded by --retries (the scripts are idempotent, so a re-run resumes).",
            "AI-optional. Set ANTHROPIC_API_KEY (or AI_PROVIDER + its key) to parse a natural-language --prompt and add free-form failure diagnosis; without a key it falls back to the deterministic issue matcher.",
            "Bootstrap a fresh machine (--repo). Without a checkout, --repo git-clones the platform repo first, then runs from it. The clone is sparse + partial (--filter=blob:none + cone sparse-checkout, git ≥ 2.27 — else a full-clone fallback): it materializes only the deploy folders the selected target + options need. Re-syncs are additive — a single --workdir can accumulate multiple targets. Override with --repo <url>, --ref <branch|tag>, --workdir <dir>.",
            "Run in Docker, zero host installs. deploy/bin/provision-docker.sh runs infra provision inside a throwaway node:24-slim container, installing only the tools the chosen target needs. Args pass straight through. (On macOS the container can't drive Docker Desktop's CLI, so run local on the host instead — the wrapper shines for the AWS targets.)",
            "Post-install steps. After deploy + health, infra provision registers the admin (non-interactive with --admin-email/--admin-password) and runs opt-in loads — passed as flags or offered interactively after the clone when none are given: --with-plugins (adds deploy/plugins + deploy/codebuild), --with-compliance, --with-samples, --with-all, --with-smoke-test, --with-events (AWS event ingestion: three infra store-token runs write the platform, registry:push and reporting:ingest service-account keys to Secrets Manager, then infra setup-events --scoped-ingest deploys the EventBridge → SQS → Lambda), and repeatable --post-step \"<cmd>\". Default is register-only; --init skip skips even that. All steps are idempotent."
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
              "Scaffold a new pipeline project with cdk.json and starter config"
            ],
            [
              "pipeline synth",
              "Run CDK synth to emit the CloudFormation template for the pipeline"
            ],
            [
              "pipeline deploy",
              "Deploy the synthesized pipeline stack to AWS (also registers the pipeline with the platform by its pipelineId)"
            ],
            [
              "pipeline register",
              "Re-register a deployed pipeline and drain pending intents queued by prior failed deploys (recovery path; exits non-zero if any registration still fails)"
            ],
            [
              "status",
              "Report the current deployment and execution status"
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
              "Register a new pipeline definition with the platform"
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
              "Scaffold a plugin FROM a pipeline-<eco>-base image (--base, list them with --list-bases): a Dockerfile that follows the catalog rules, a plugin-spec.yaml with catalog metadata (summary, description, version 0.1.0, category, license, smokeTest, optional curated --icon, a changelog entry), README.md and LICENSE. It passes plugin validate and test-plugins.sh as generated. See Authoring a plugin"
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
              "template instantiate",
              "Render a golden-path pipeline template into concrete pipeline props — resolve it by --name (or --id), supply its declared inputs with repeatable --input k=v / --inputs-file, and write the result to --output (or stdout). Creates nothing: feed the props to pipeline create --file, which is where compliance and quota apply"
            ],
            [
              "template validate",
              "Parse and validate {{ ... }} templates in a pipeline or plugin spec (local file, registered pipeline by ID, or registered plugin by name:version)"
            ],
            [
              "org export",
              "Export an organization's data as JSON for GDPR portability (sysadmins can export any org; org admins their own only)"
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
              "Sign in through your browser using the OAuth 2.0 device authorization grant (RFC 8628): the CLI prints a short code, you approve it in the browser (where SSO and step-up already apply), and the session is stored in ~/.pipeline-manager/credentials.json. --org <orgId> switches organization afterwards; --no-browser prints the URL instead of opening it. There is no password flag and no way to pass a refresh token"
            ],
            [
              "auth pat",
              "Create a named access key (pb_pat_…) for CI. Uses the same browser sign-in, and the approval doubles as the step-up the platform requires to create a key — so no password is typed here either. The key is printed once"
            ],
            [
              "infra store-token",
              "Provision the org's machine identity — a service account plus one pb_sa_… key — and store the key in AWS Secrets Manager (read by CodeBuild's registry credentials, the plugin-lookup Lambda, the events Lambda and --store-tokens). Add --schedule to also deploy a daily key-rotation stack (rotate → store → revoke) so the key never lapses. Re-run per scope (--scope reporting:ingest, --scope registry:push) — each is its own least-privilege account. Needs PLATFORM_PASSWORD: both writes are step-up gated"
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
              "Diff CloudFormation stacks tagged pipeline-builder against the platform's pipeline_registry. Surfaces orphaned stacks (no DB row) and missing stacks (DB row, no live stack). See drift detection.",
              "0 clean / 1 findings / 2 AWS error"
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
          "content": "Codes are defined in src/types/error.ts; the derivation lives in src/utils/error-handler.ts (resolveExitCode). The operator-audit commands additionally use exit 1 to signal \"findings present\" (see Operator audits)."
        }
      ]
    },
    {
      "id": "configuration",
      "title": "Configuration",
      "blocks": [
        {
          "type": "text",
          "content": "The CLI resolves its settings from three layers, lowest to highest precedence:"
        },
        {
          "type": "list",
          "items": [
            "Built-in defaults",
            "User config file — ~/.pipeline-manager/config.yml",
            "Project config file — CLI_CONFIG_PATH, else ./config.yml"
          ]
        },
        {
          "type": "text",
          "content": "Environment variables override the resolved config."
        },
        {
          "type": "text",
          "content": "How commands authenticate, in priority order:"
        },
        {
          "type": "list",
          "items": [
            "PLATFORM_TOKEN — always wins. This is what CI sets, to an access key from auth pat.",
            "The session auth login stored for this platform's base URL, in ~/.pipeline-manager/credentials.json (owner-only, 0600). It carries the access token and its refresh token, so the CLI renews the session itself and you sign in roughly as often as the refresh token's 30-day life requires.",
            "--store-tokens with PLATFORM_SECRET_NAME — the service-account key in AWS Secrets Manager (infra store-token). A command given --store-tokens never falls back to your personal session."
          ]
        },
        {
          "type": "text",
          "content": "Sign a stored session out from the dashboard (Settings → Sessions and devices) — it appears there as a signed-in device like any other."
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
              "Yes (for API ops)",
              "Base URL of your platform deployment"
            ],
            [
              "AWS_REGION",
              "Yes (for deploy)",
              "Target AWS region for pipeline synth / pipeline deploy / infra provision teardown"
            ],
            [
              "CLI_CONFIG_PATH",
              "No",
              "Override the project config file path (default ./config.yml)"
            ],
            [
              "UPLOAD_TIMEOUT",
              "No",
              "Override the plugin-upload request timeout (ms)"
            ],
            [
              "SKIP_BUNDLER_CHECK",
              "No",
              "Set to 1 to skip the esbuild + pnpm preflight before pipeline synth/deploy (see local deploy prerequisites)"
            ],
            [
              "TLS_REJECT_UNAUTHORIZED",
              "No",
              "Set to 0 to skip TLS verification (ignored in NODE_ENV=production)"
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
          "content": "pipeline-manager auth login --url https://platform.example.com\npipeline-manager infra bootstrap\npipeline-manager pipeline synth\npipeline-manager pipeline deploy\npipeline-manager status",
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
            "Bases. The Dockerfile starts FROM pipeline-<eco>-base (plugin, aws-cli, cpp, dotnet, go, jvm, node, php, python, ruby, rust, trivy). plugin test and the scan preview build it locally, so build the bases first with deploy/bin/build-plugin-images.sh, or pass --image.",
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
            "A qualified step's construct id is <publisher>-<name> (when it has no alias) and its default artifact alias is <publisher>-<name>-alias. Unqualified references are unchanged."
          ]
        },
        {
          "type": "text",
          "content": "See Plugin Installing for installs, version policies and the resolution order."
        },
        {
          "type": "text",
          "content": "Schedule drift detection (cron)"
        },
        {
          "type": "code",
          "content": "pipeline-manager audit stacks   || alert \"stack drift detected\"\npipeline-manager audit tokens --warn-days 14 || alert \"tokens expiring soon\"",
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
