# @pipeline-builder/pipeline-events

📖 **[View documentation](https://mwashburn160.github.io/pipeline-builder/)**

AWS Lambda handler for [Pipeline Builder](https://mwashburn160.github.io/pipeline-builder/) that ingests CodePipeline state-change events from EventBridge and forwards normalized payloads to the reporting service.

> Internal workspace package. This is not imported by other packages — it is deployed as a Lambda by the CLI's `setup-events` command, which provisions the full EventBridge → SQS → Lambda stack (rule, queue, dead-letter queue, IAM, and this handler).

## Responsibilities

1. Receives CodePipeline (pipeline / stage / action) events delivered as an SQS batch sourced from EventBridge.
2. Classifies each record into a normalized event type (`PIPELINE`, `STAGE`, `ACTION`) and derives status, start/completion times, run duration, and — on failures — the `errorMessage` (from the action's `execution-result.external-execution-summary`).
3. Resolves each pipeline's tags via `codepipeline:ListTagsForResource`, cached per pipeline. The ARN and AWS account never leave AWS, so there is no masking/secret to manage. Untagged (unregistered) pipelines are skipped.
4. Resolves the DORA **commit range** in-account for source/deploy events (Phase 4) and attaches `commitTimestamp`/`commitCount`.
5. Posts the normalized batch (keyed by `pipelineId`) to the reporting service via `POST /api/reports/events`.
6. After a successful batch, emits a **delivery-health** signal and **self-heals the dead-letter queue** (Phase 3).

CodeBuild `Build State` events are skipped: a build project can be shared across pipelines, so there is no clean 1:1 mapping to a pipeline id.

### Tag standard (pipeline-core generates → this forwarder parses)

| Tag | Value | Purpose |
|---|---|---|
| `pb.pipeline-id` | `<platform pipelineId>` | The platform pipeline id to report against. Pipelines **without** this tag are unregistered and skipped. |
| `pb.deploys` | `<stage>:<env>` pairs joined by `+`, e.g. `Deploy-stg:staging+Deploy-prod:production` | Declares which stages are deploys and to which environment. CodePipeline-tag-safe (`:` `+` allowed; no JSON). |

The forwarder parses `pb.deploys` into a `stage → environment` map. For a `STAGE`/`ACTION` event it sets `environment` **only** when the event's stage matches a key in the map — that (and only that) marks the event as a deploy (`isDeploy` is derived server-side as `environment IS NOT NULL`). `PIPELINE` events have no stage and are never deploys.

> No backward compatibility: the old `PIPELINE_EVENT_ID` and `Environment` tags are gone. Already-deployed pipelines produce no DORA data until they re-synth with the new tags.

## Data forwarded to the platform

The Lambda forwards **only pipeline-execution telemetry** — enough to compute
success rates, stage/action timing, and DORA metrics. It runs **inside your AWS
account**; the reporting service only ever receives the normalized payload below.

### NOT forwarded (stays in your AWS account)

- **AWS account number** — explicitly stripped from every event (`delete detail.account`).
- **The pipeline ARN** (`arn:aws:codepipeline:<region>:<account>:<name>`) — built only as a
  transient handle to look up the pipeline's `pb.pipeline-id` tag, then discarded; it is
  never stored or sent.
- **Source-revision URLs** (`revisionUrl`) — read only in-account to classify the source type
  (CodeCommit / GitHub / Bitbucket) for commit-range resolution; not forwarded on their own.
- **AWS credentials / IAM** and any account-identifying identifiers.

The platform stores no AWS account id anywhere (schemas, JWTs, and APIs are account-id-free
by design), so there is nothing to mask.

### Forwarded payload (per event)

`POST /api/reports/events` with a batch of:

| Field | Type | Notes |
|---|---|---|
| `pipelineId` | string | The **platform** pipeline id (from the `pb.pipeline-id` tag) — not the ARN |
| `eventSource` | `codepipeline` | |
| `eventType` | `PIPELINE` \| `STAGE` \| `ACTION` | |
| `status` | enum | The CodePipeline state (`SUCCEEDED`/`FAILED`/…) |
| `idempotencyKey` | string | Deterministic dedupe key derived from the event's own identity (no PII) |
| `executionId` | string? | CodePipeline execution GUID |
| `stageName` / `actionName` | string? | |
| `errorMessage` | string? | Human-readable failure summary (capped), on failures |
| `startedAt` / `completedAt` | ISO 8601? | Event timestamps |
| `durationMs` | number? | |
| `commitSha` / `commitRef` | string? | Source revision — DORA deploy attribution |
| `commitTimestamp` | ISO 8601? | Oldest-unshipped commit time for the range since the last deploy — resolved **in-account** (Phase 4). Omitted when unresolvable (reporting falls back to `unknown`) |
| `commitCount` | number? | Number of commits (≥1) in that range. Omitted when unresolvable |
| `environment` | string? | Set only when the event's stage is listed in the pipeline's `pb.deploys` tag (⇒ this event is a deploy) |
| `detail` | object | The raw CodePipeline event detail **with `account` removed** — carries the execution result (log URL, error code) for drill-down |

### Commit-range resolution (Phase 4, in-account)

For a source/deploy event carrying a `commitSha`, the forwarder resolves the commit timestamp(s) for the range **since the last deploy of that pipeline**, entirely inside your AWS account, per source type detected from the revision URL:

- **CodeCommit** → AWS SDK `codecommit:GetCommit` (walks first-parents back to the previous shipped commit).
- **GitHub / CodeConnections-GitHub** → GitHub REST `compare` / `commits` API. Authenticated with the org's `pipeline-builder/{orgId}/github-token` secret when present (the secret name is derived from `PLATFORM_SECRET_NAME` by swapping the trailing `/platform` for `/github-token`; the value is the raw token string). Falls back to best-effort unauthenticated calls otherwise.
- **Bitbucket** → Bitbucket REST commit API (single-commit).

It emits `commitTimestamp` (oldest unshipped commit) and `commitCount`. Results are cached per commit; SCM rate limits (403/429) trigger a short cooldown; and **any** failure simply omits the fields — commit resolution never fails the batch. The last-shipped commit is tracked in-memory per warm container, so the first deploy after a cold start resolves as a single commit.

### Delivery health + self-healing redrive (Phase 3)

After a **successful** batch POST, the forwarder (throttled per warm container, best-effort, never failing the batch):

1. POSTs a delivery-health signal to `POST /api/reports/ingest-health` `{ forwarded, dropped, lastEventAt }` so the Reports UI can show flowing / stale / dropping. `forwarded` accumulates across batches between health posts; `dropped` is the current DLQ depth snapshot; `lastEventAt` is the newest event timestamp seen.
2. If the dead-letter queue is non-empty **and** no message-move task is already running, starts an SQS `StartMessageMoveTask` (DLQ → main queue) so retryable failures self-heal without a new AWS service. Guarded: success-gated, one-at-a-time (`ListMessageMoveTasks`), and throttled. Idempotent ingest (`idempotencyKey`) prevents double-counting on redelivery. The DLQ ARN defaults to `<main-queue-arn>-dlq` (derived from the SQS trigger ARN) and can be overridden with `EVENT_DLQ_ARN`.

## Key exports

| Export | Purpose |
|---|---|
| `handler(event: SQSEvent)` | The Lambda entry point. Parses + resolves the SQS batch and POSTs normalized events to the reporting service. |

## Runtime

- Lambda Node.js runtime, using the runtime-provided `@aws-sdk` clients (`client-codepipeline`, `client-secrets-manager`, and — loaded lazily only when needed — `client-codecommit` and `client-sqs`).
- Triggered by an SQS queue fed by an EventBridge rule matching the `aws.codepipeline` source; processes events in batches and POSTs them in a single request per invocation.
- Requires `PLATFORM_BASE_URL` (set by `setup-events`). Optional: `EVENT_DLQ_ARN` (self-healing redrive; defaults to `<main-queue-arn>-dlq`).
- Authenticates with either `PLATFORM_TOKEN` (a JWT set directly) or `PLATFORM_SECRET_NAME` (a Secrets Manager secret holding the JWT in `password`, created via `pipeline-manager infra store-token`); the resolved token is cached across invocations.

### IAM required by this handler

The execution role (granted on the events stack — `pipeline-manager/src/templates/events-stack.json`) must allow:

| Action | Resource | Used by |
|---|---|---|
| `codepipeline:ListTagsForResource` | the pipelines | Tag resolution. An `AccessDenied` here is logged as an error and **fails the batch**, so a missing grant is visible rather than silent. |
| `secretsmanager:GetSecretValue` | `pipeline-builder/*/platform-*` | Platform JWT (auth). |
| `secretsmanager:GetSecretValue` | `pipeline-builder/*/github-token-*` | GitHub/Bitbucket commit resolution (Phase 4). Best-effort: absent/denied ⇒ unauthenticated fallback. |
| `codecommit:GetCommit` | the CodeCommit source repositories | CodeCommit commit resolution (Phase 4). Best-effort. |
| `sqs:ReceiveMessage`, `sqs:DeleteMessage`, `sqs:GetQueueAttributes` | the main queue | SQS trigger + DLQ depth check. |
| `sqs:GetQueueAttributes`, `sqs:ListMessageMoveTasks`, `sqs:StartMessageMoveTask` | the **dead-letter queue** | Self-healing redrive (Phase 3). |

> The Phase 3/4 actions (`codecommit:GetCommit`, the `github-token` secret read, and the three DLQ `sqs:*` actions) are new grants required by this code — the events-stack IAM owner must add them. All Phase 3/4 paths are best-effort: a missing grant degrades gracefully (fields omitted / redrive skipped) and never fails the batch.

## Development

```bash
pnpm build   # projen build (compile + lint + test + package)
pnpm test    # run the Jest test suite
```

## License

Apache-2.0. See [LICENSE](./LICENSE).
