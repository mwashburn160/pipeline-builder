# `cdk-synth` plugin

Synthesizes a Pipeline Builder pipeline definition (stored in the platform's
database) into a CDK CloudAssembly (`cdk.out/`) for downstream `cdk-deploy` to
consume. Acts as the bridge between the platform's stored pipeline JSON and
AWS CDK's stack model.

## What it does

When CodeBuild runs this plugin, it:

1. Health-checks the platform service at `${PLATFORM_BASE_URL}/health` —
   fail-fast if the platform is unreachable, since synthesis depends on
   fetching the pipeline definition from it.
2. Invokes the bundled `pipeline-manager synth` CLI (an internal binary
   pinned to `@pipeline-builder/pipeline-manager@1.6.6` in the Dockerfile)
   with the pipeline ID provided in `${PIPELINE_ID}`.
3. Writes the resulting CloudAssembly to `cdk.out/`, which `cdk-deploy`
   reads from in the next pipeline stage.

## Why it's special

Most plugins are stateless tool wrappers (run `eslint`, run `pytest`,
upload to Snyk). `cdk-synth` is the only plugin in the catalog that:

- **Calls back to the platform service** — it's not standalone. The pipeline
  it's synthesizing was authored in the platform's UI/API and lives in the
  platform's database. Synthesis fetches the latest definition fresh.
- **Bundles a Pipeline Builder internal binary** (`pipeline-manager`) — most
  plugins use only public, vendor-published tools.
- **Uses CDK metadata flags** in the plugin-spec — sets
  `aws:cdk:pipelines:codepipeline:dockerenabledforselfmutation`,
  `aws:cdk:pipelines:codepipeline:publishassetsinparallel`, and
  `aws:cdk:codebuild:buildenvironment:privileged` so the synthesized CDK
  pipeline can self-mutate and run privileged Docker builds.

## Required pipeline env

| Env var | Source | Purpose |
|---|---|---|
| `PIPELINE_ID` | CodeBuild env (set by parent pipeline) | UUID of the pipeline definition to synth |
| `PLATFORM_BASE_URL` | CodeBuild env | URL of the platform service for fetching the definition |
| `AWS_REGION`, `AWS_ACCOUNT_ID` | CodeBuild env | Standard AWS context for CDK |
| `RESOLVED_SYNTH_PLUGIN` | Always `'true'` | Flag that pipeline-manager checks to confirm it's running inside the synth plugin (not invoked locally) |

## Failure modes

- **`Platform unreachable at ${PLATFORM_BASE_URL}`** — health check failed.
  Verify the platform service is running and the URL is reachable from
  CodeBuild's VPC/IAM context.
- **Pinned `pipeline-manager` mismatch** — the Dockerfile pins
  `@pipeline-builder/pipeline-manager@1.6.6`. If the platform schema has
  changed (e.g., added required pipeline fields), the bundled binary may
  fail to deserialize. Bump the pin in the Dockerfile and rebuild.
- **CDK construct missing** — pipeline-manager translates the stored
  pipeline definition into CDK constructs. If the definition references a
  plugin that has been removed from the platform, synth fails with a
  resolution error.

## Local testing

```bash
docker build -t cdk-synth-test deploy/plugins/infrastructure/cdk-synth

# Smoke test — image launches
docker run --rm cdk-synth-test bash -c 'pipeline-manager --version'

# End-to-end test — needs a running platform service and a valid pipeline ID
docker run --rm \
  -e PLATFORM_BASE_URL=http://host.docker.internal:8080 \
  -e PIPELINE_ID=<your-pipeline-uuid> \
  -e AWS_REGION=us-east-1 \
  -e AWS_ACCOUNT_ID=123456789012 \
  cdk-synth-test \
  pipeline-manager synth --id "$PIPELINE_ID" --output cdk.out
```

## See also

- [Pipeline Builder docs/plugins/infrastructure.md](../../../../docs/plugins/infrastructure.md) — public catalog entry
- [`infrastructure/cdk-synth/plugin-spec.yaml`](plugin-spec.yaml) — the spec this plugin ships
- [`deploy/plugins/README.md`](../../README.md) — contributor guide
- The [pipeline-manager CLI](https://www.npmjs.com/package/@pipeline-builder/pipeline-manager) on npm
