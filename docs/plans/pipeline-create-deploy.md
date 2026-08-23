# Strategy & Plan: `pipeline create` → create **and** deploy

**Status:** IMPLEMENTED (opt-in `--deploy`) · **Authored:** 2026-08-22

> Shipped: `runDeploy` extracted to `src/utils/deploy-runner.ts` (deploy.ts now delegates); `create` gained `--deploy` + `--profile`/`--region`/`--require-approval`/`--output`/`--store-tokens`; create-fails-→-keep-record-and-print-retry; `--dry-run` notes the deploy; CLI example added; `test/deploy-runner.test.ts` (5 cases). Full pipeline-manager suite green.

## Goal

Let `pipeline-manager pipeline create` optionally **deploy** the pipeline it just created — one command from a props file to a live AWS CodePipeline — with the deploy-time parameters `pipeline deploy` already takes. Today it's two steps: `create` (writes the platform record) then `deploy --id <id>` (CDK deploy + registry). This collapses the happy path into `create -f props.json --deploy --profile prod`.

## Current state (grounded)

**`pipeline create`** — `packages/pipeline-manager/src/commands/create-pipeline.ts`
- Reads a props JSON file → validates → resolves project/org/name → `POST` platform API (`config.api.pipelineUrl`) → prints the new `pipeline.id`.
- Options: `-f/--file`, `-p/--project`, `-o/--organization`, `-n/--name`, `-a/--access`, `--default`, `--active/--no-active`, `--dry-run`, SSL opts.
- Compliance is enforced **server-side** at create (the API blocks on violations). Ends by literally suggesting *"Deploy: deploy --id <id>"*.

**`pipeline deploy`** — `packages/pipeline-manager/src/commands/deploy.ts`
- Options: `-i/--id` (or `--local-spec`), `--require-approval` (default `never`), `--output` (`cdk.out`), `--store-tokens`, `--show-resolved`, plus `--profile` / `--region` / SSL.
- Flow (inline in `.action`): `fetchPipelineProps(client, id)` (utils/pipeline-config.ts) → resolve plugins + bake registry pull-host → base64 into `PIPELINE_PROPS` env → `executeCdkShellCommand("cdk deploy …")` (utils/cdk-utils.ts) → register the deployed ARN (`buildRegistryPayload` / `writePendingIntent`, utils/registry.ts).
- Needs **AWS creds** (profile/region) on top of the platform auth `create` uses.

**Registration:** `cli.ts:213-219` wires the `pipeline` subcommands (`createPipeline`, …, `deploy`).

## Strategy — key decisions

1. **Opt-in, not default.** Add a `--deploy` flag to `create`; without it, behavior is unchanged (pure record creation). Rationale: deploy requires AWS creds/profile that record-only users don't have, and forcing it would break the common "just register the config" use. (If the team prefers create-always-deploys per the forward-only ethos, that's the "Open decisions" item below — but `--deploy` is the safe default and still satisfies "both create and deploy".)

2. **Extract the deploy flow into a shared helper — don't duplicate.** The deploy logic is currently inline in `deploy.ts`'s `.action`. Refactor it into `runDeploy(opts)` in a new `utils/deploy-runner.ts` (or `commands/deploy-core.ts`), consumed by **both** `deploy` and the new `create --deploy` path. This is the linchpin: it prevents drift between the two entry points.

3. **Pass the just-created props/id directly — skip the redundant fetch.** `create` already holds the resolved `props` and the new `id`. `runDeploy` should accept **either** `{ pipelineId }` (fetch from platform, the `deploy --id` path) **or** `{ pipelineId, props }` (use in-hand props, the create path) so the create flow doesn't round-trip `fetchPipelineProps` for data it just sent. Keep a single `resolvePlugins`/registry-host step inside `runDeploy` so both paths behave identically.

4. **Create is authoritative for the record; deploy is best-effort after.** If create succeeds but deploy fails, the **record still exists** — do NOT roll it back. Report the created `id`, the deploy error, and the exact retry (`pipeline deploy --id <id> --profile …`), and exit non-zero. This matches the "unresolved step = fail, not false-green" convention.

5. **Reuse existing option helpers.** Add `withProfileOption`/`withRegionOption` to `create` (it currently has only `withSslOptions`) so the deploy params are available; validate that deploy-only flags aren't passed without `--deploy` (warn, don't hard-fail).

## Extra parameters added to `create` (all gated on `--deploy`)

| Flag | Source | Meaning |
|---|---|---|
| `--deploy` | new | Deploy the pipeline immediately after creating it. |
| `--profile <p>` | from deploy | AWS profile for `cdk deploy`. |
| `--region <r>` | from deploy | AWS region for the deploy + registry. |
| `--require-approval <lvl>` | from deploy | `never\|any-change\|broadening` (default `never`). |
| `--output <dir>` | from deploy | CDK output dir (`cdk.out`). |
| `--store-tokens` | from deploy | Auth the registry callback via Secrets Manager (`PLATFORM_SECRET_NAME`). |

`--dry-run` extends to preview **both** the create payload and the resolved deploy config (no record, no CDK).

## Implementation plan

**Phase 1 — Extract `runDeploy` (pure refactor, no behavior change).**
- Move the body of `deploy.ts`'s `.action` into `runDeploy(opts: DeployRunnerOptions)` in `utils/deploy-runner.ts`. Signature accepts `{ pipelineId?, props?, localSpecPath?, profile, region, requireApproval, output, storeTokens, showResolved, ssl }` and returns `{ stackArn?, region?, registered: boolean }`.
- `deploy.ts` `.action` becomes a thin wrapper that parses options → `runDeploy`.
- Verify: existing `deploy` tests still pass (this is the safety net for the refactor).

**Phase 2 — Wire `create --deploy`.**
- Add `--deploy` + the deploy flags (Extra parameters table) to `create-pipeline.ts` via the shared option helpers.
- After a successful create (have `pipeline.id` + `props`), if `--deploy`: call `runDeploy({ pipelineId: pipeline.id, props, …deployOpts })`.
- Single combined output: **Create** section → **Deploy** section → summary (id · stack ARN · region · registry status).
- Guard: if `--deploy` and no AWS creds resolvable, fail early with a clear message *before* creating (so we don't leave an undeployed record for a trivially-missing profile). Everything else (deploy failures mid-CDK) leaves the record and prints the retry.

**Phase 3 — Dry-run + validation polish.**
- `--dry-run --deploy` prints the create payload AND the resolved deploy config (reuse `printResolvedOrExit`), creates/deploys nothing.
- Warn if deploy-only flags are set without `--deploy`.

**Phase 4 — Tests.**
- `runDeploy` unit tests (moved/renamed from deploy's).
- `create --deploy`: (a) create ok + deploy ok → both run, summary shows ARN; (b) create ok + deploy fails → non-zero exit, record kept, retry printed; (c) no `--deploy` → create only (deploy never invoked); (d) `--dry-run --deploy` → nothing created/deployed; (e) `--deploy` without creds → fails before create.

**Phase 5 — Docs.**
- Update the CLI help/epilog (`cli.ts:164,187`) and any `docs/*` CLI reference to show `create --deploy`.
- Note the create-then-deploy semantics + the "record kept on deploy failure, re-run `deploy --id`" recovery.

## Error handling / edge cases

- **Partial success** (create ok, deploy fail): keep the record, exit 1, print `deploy --id <id>`. Never silently green.
- **Idempotency:** re-running `create` makes a NEW record (create isn't idempotent). Document; out of scope to change here.
- **Compliance:** enforced at create (server-side block) — a compliance-blocked pipeline never reaches deploy. No new gate needed.
- **`--local-spec`:** unchanged; it's a `deploy`-only concept (no platform record), orthogonal to `create --deploy`.
- **Registry callback token:** `--store-tokens` path is reused verbatim via `runDeploy`.

## Risks / open decisions

1. **Default behavior** — `--deploy` opt-in (recommended) vs. create-always-deploys (forward-only). Opt-in avoids breaking record-only users; decide before Phase 2.
2. **Auth surface** — the combined command now needs platform auth *and* AWS creds in one invocation; confirm the credential-resolution order and error messaging.
3. **Where `runDeploy` lives** — `utils/deploy-runner.ts` vs `commands/deploy-core.ts`; pick to match existing module conventions.
4. **Return richness** — how much of the deploy result (ARN/region/registry state) to thread back into the create summary.

## Files touched

| File | Change |
|---|---|
| `packages/pipeline-manager/src/utils/deploy-runner.ts` (new) | `runDeploy()` extracted from `deploy.ts` |
| `packages/pipeline-manager/src/commands/deploy.ts` | thin wrapper → `runDeploy` |
| `packages/pipeline-manager/src/commands/create-pipeline.ts` | `--deploy` + deploy flags; call `runDeploy` after create |
| `packages/pipeline-manager/src/cli.ts` | help/epilog examples |
| `packages/pipeline-manager/test/*` | `runDeploy` + `create --deploy` cases |
| `docs/*` CLI reference | document the combined flow |
