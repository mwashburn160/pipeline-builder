# CI/CD samples — create & deploy from your pipeline

Ready-to-copy CI configurations that create a Pipeline Builder pipeline **and**
deploy it to AWS in a single step, using:

```bash
pipeline-manager pipeline create --file <props.json> --deploy --region <region>
```

`--deploy` creates the pipeline record on the platform, then runs `cdk deploy`
for it and registers the deployed CodePipeline ARN. A green CI run therefore
means the pipeline both **exists on the platform** and is **deployed to AWS**.

| Provider | Copy to | Sample |
|----------|---------|--------|
| GitHub Actions | `.github/workflows/deploy-pipeline.yml` | [github-actions/deploy-pipeline.yml](github-actions/deploy-pipeline.yml) |
| GitLab CI/CD | `.gitlab-ci.yml` | [gitlab/.gitlab-ci.yml](gitlab/.gitlab-ci.yml) |
| CircleCI | `.circleci/config.yml` | [circleci/config.yml](circleci/config.yml) |

Each sample deploys [`deploy/samples/pipelines/react-javascript/pipeline.json`](../pipelines/react-javascript/pipeline.json)
by default — point `--file` / `PROPS_FILE` at your own props file (see the other
folders under [`deploy/samples/pipelines/`](../pipelines/)).

## What each job needs

**Toolchain** (installed by every sample): Node 24+, plus `pipeline-manager`,
`aws-cdk`, `esbuild`, and `pnpm` on `PATH` — `--deploy` shells out to
`cdk deploy`, whose synth uses esbuild + pnpm.

**Platform auth** (CI secrets/variables):

| Name | Value |
|------|-------|
| `PLATFORM_BASE_URL` | Base URL of your platform, e.g. `https://pipeline.example.com` |
| `PLATFORM_TOKEN` | A Personal Access Token — create with `pipeline-manager auth pat` or the dashboard |

**AWS auth**: every sample uses the provider's OIDC federation to assume a
deploy role (no long-lived keys). Store the role ARN as a CI secret/variable
(`AWS_DEPLOY_ROLE_ARN`) — it is never committed. The role trusts the CI
provider's OIDC issuer and carries CDK/CloudFormation deploy permissions. To use
static access keys instead, each sample notes the one-line swap.

Set `AWS_REGION` (or pass `--region`); region otherwise resolves from
`AWS_REGION` → `CDK_DEFAULT_REGION` → `us-east-1`.

## Exit codes

`pipeline-manager` returns standard exit codes so CI fails on the right things:
`0` success · `2` validation · `3` API request · `4` authentication ·
`5` authorization · `6` not found · `7` network · `8` configuration · `10`
timeout. If create succeeds but the deploy fails, the command exits non-zero and
prints `pipeline-manager pipeline deploy --id <id>` so you can retry the deploy
without recreating the record.
