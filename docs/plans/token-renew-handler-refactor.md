# Plan: Refactor token-renew-handler to delegate to `pipeline-manager store-token`

## Goal

Replace the self-contained token-renewal Lambda (which re-implements the JWT
generate/refresh/validate/write logic with `node:https`) with a **thin
orchestrator** that reuses the already-tested `pipeline-manager store-token`
command. The handler, on each daily run:

1. Configure npm so the `@pipeline-builder` scope resolves from public npm.
2. **Download `@pipeline-builder/pipeline-manager` from npm** into `/tmp`.
3. **Retrieve the platform JWT secret** from AWS Secrets Manager.
4. **Execute `pipeline-manager store-token`** — which mints a fresh long-lived
   token via `/api/user/generate-token` and writes it back to the same secret.

This deletes ~120 lines of duplicated token logic and makes the CLI the single
source of truth for how a token is minted and stored.

## Current state (to be changed)

- `src/lambda/token-renew-handler.ts` — self-contained ESM handler: `GetSecret` →
  `POST /generate-token` (Bearer) → `/auth/refresh` fallback → JWT validation →
  `PutSecret`. **This whole body is replaced.**
- `src/templates/token-renew-stack.json` — Lambda (placeholder code) + IAM role
  (Get/Put secret) + EventBridge schedule + invoke permission. Env:
  `PLATFORM_BASE_URL`, `PLATFORM_SECRET_NAME`, `RENEW_DAYS`.
- `src/commands/store-token.ts` — the CLI: authenticates via `PLATFORM_TOKEN`,
  `POST /api/user/generate-token`, writes the secret via `upsertSecret`; with
  `--schedule` (opt-in, off by default) it also deploys this stack + uploads the
  handler.

## New handler design — `src/lambda/token-renew-handler.ts`

ESM handler (uploaded as `index.mjs`, `Handler=index.handler`). Imports only
`@aws-sdk/client-secrets-manager` (runtime-provided) + `node:child_process` +
`node:fs`. Steps:

1. **Read env**: `PLATFORM_SECRET_NAME`, `PLATFORM_BASE_URL`, `RENEW_DAYS`
   (default 30), `PIPELINE_MANAGER_VERSION` (default `latest`), `AWS_REGION`.
2. **npm scope config**: write `/tmp/.npmrc` containing exactly:
   ```
   @pipeline-builder:registry=https://registry.npmjs.org/
   ```
   so the scoped package resolves from public npm regardless of any inherited
   registry. Run npm with `HOME=/tmp` (or `--userconfig /tmp/.npmrc`) and
   `npm_config_cache=/tmp/.npm` (Lambda's only writable dir is `/tmp`).
3. **Download pipeline-manager**:
   ```
   npm install --prefix /tmp/pm --no-audit --no-fund \
     @pipeline-builder/pipeline-manager@${PIPELINE_MANAGER_VERSION}
   ```
   CLI entrypoint resolves to
   `/tmp/pm/node_modules/@pipeline-builder/pipeline-manager/dist/cli.js`
   (`bin.pipeline-manager` → `./dist/cli.js`, package is ESM).
4. **Retrieve the JWT secret**: `GetSecretValueCommand(PLATFORM_SECRET_NAME)` →
   parse `{ password: <current JWT> }`. This token authenticates the renewal.
5. **Execute store-token** via `execFileSync('node', [cliPath, 'store-token', …])`
   with:
   - args: `--secret-name ${PLATFORM_SECRET_NAME}`, `--region ${AWS_REGION}`,
     `--days ${RENEW_DAYS}`, `--no-verify-ssl` only if explicitly configured.
     It does NOT pass `--schedule` (the default), so the renewal run never
     redeploys its own stack (avoids recursion).
   - env: `PLATFORM_TOKEN=<current JWT>`, `PLATFORM_BASE_URL`, `HOME=/tmp`,
     `npm_config_cache=/tmp/.npm`, plus the inherited AWS creds (Lambda role).
   - `stdio: 'inherit'` so CLI output lands in CloudWatch.
6. On non-zero exit (npm or CLI), `throw` so the invocation is marked failed
   (surfaces in CloudWatch / can alarm). On success, log the renewed expiry.

`store-token` already writes the secret in the canonical schema
(`{username,password,refreshToken?,platformUrl,expiresIn,expiresAt,createdAt}`)
and uses the AWS SDK default credential chain → picks up the Lambda role. No
token logic remains in the handler.

> Note on expiry: delegating to `store-token` drops the handler's old
> `/auth/refresh`-on-401 fallback. That's acceptable because the schedule renews
> daily while the token lives `RENEW_DAYS` (default 30), so the current JWT is
> always valid when used as `PLATFORM_TOKEN`. (Optional follow-up: add a refresh
> fallback inside `store-token` itself if we ever want self-healing from a lapse.)

## CFN stack changes — `src/templates/token-renew-stack.json`

- **`Timeout`: 60 → 300** and **`MemorySize`: 256 → 1024** — a cold `npm install`
  of pipeline-manager (many deps) needs headroom.
- **Env adds** `PIPELINE_MANAGER_VERSION` (new param `PipelineManagerVersion`,
  default `latest`).
- **IAM role** widened to exactly what `store-token`'s `upsertSecret` /
  `getSecretArn` call (from `aws-secrets.ts`): `secretsmanager:GetSecretValue`,
  `PutSecretValue`, `UpdateSecret`, `DescribeSecret`, `CreateSecret` on
  `arn:aws:secretsmanager:${Region}:${Account}:secret:pipeline-builder/*/platform-*`.
  (`ListSecrets`, if reached, is account-level and needs `Resource: "*"` — prefer
  to avoid by ensuring the secret-exists path uses Describe/Get.)
- Lambda must have **outbound internet** (registry.npmjs.org + platform URL).
  Current stack creates no VPC, so the function runs with AWS-managed egress —
  fine. (If it is ever placed in a VPC, it needs a NAT path — call out in README.)
- Placeholder `Code.ZipFile` stays; the real (now tiny) handler is uploaded by
  `store-token` as today.

## CLI change — `src/commands/store-token.ts`

- When deploying the renewal stack, pass the **deployer's own pipeline-manager
  version** as `PipelineManagerVersion` (reproducible renewals instead of a
  floating `latest`). Read it from this package's `package.json` version.
- Handler upload mechanism is unchanged, but the uploaded file is now the small
  orchestrator (no bundling of token logic).
- Stack deployment is opt-in via `--schedule` (off by default); `--cron` / `--days`
  customize it when set.

## Tests — `test/`

- Remove/replace the existing `token-renew-handler` unit tests that asserted the
  `node:https` generate/refresh/validate/PutSecret behavior.
- Add a focused test that mocks `@aws-sdk/client-secrets-manager`,
  `node:child_process`, and `node:fs`, then asserts the handler:
  - writes `/tmp/.npmrc` containing `@pipeline-builder:registry=https://registry.npmjs.org/`,
  - runs `npm install … @pipeline-builder/pipeline-manager@<version>`,
  - invokes `store-token` with `--secret-name … --region … --days …` (and NOT
    `--schedule`) and `PLATFORM_TOKEN` set to the secret's `password`,
  - throws when npm or the CLI exits non-zero.
- `cron.ts` tests unaffected.

## Trade-offs

- **Pro**: deletes duplicated token logic; one source of truth (the CLI); always
  exercises the tested `store-token` path; picks up CLI fixes automatically.
- **Con**: runtime `npm install` is slower (cold start ~1–3 min), needs egress,
  and consumes `/tmp` — mitigated by the daily cadence, raised timeout/memory,
  and `/tmp/.npm` cache. Supply-chain surface (downloads at run time) — mitigated
  by pinning `PIPELINE_MANAGER_VERSION` to the deployer's version.
- **Alternative considered (rejected)**: bundle pipeline-manager into the Lambda
  zip at deploy time (no runtime install). Rejected because the requirement is to
  download from npm at run time (smaller deploy package, always the pinned npm
  artifact).

## Decisions (defaults chosen; flag if you disagree)

- **Version**: pin `PipelineManagerVersion` to the deployer's version, not
  `latest` (reproducible). Overridable via the stack param / env.
- **Timeout/memory**: 300 s / 1024 MB.
- **SSL**: pass `--no-verify-ssl` only when an explicit
  `PLATFORM_VERIFY_SSL=false`-style env is set; default is verify.

## Execution order (once approved)

1. Rewrite `token-renew-handler.ts` (orchestrator).
2. Update `token-renew-stack.json` (timeout/memory/env/IAM/param).
3. Update `store-token.ts` (pass version on deploy).
4. Swap the tests.
5. `npx tsc --noEmit` + `NODE_OPTIONS=--experimental-vm-modules pnpm exec jest`.
