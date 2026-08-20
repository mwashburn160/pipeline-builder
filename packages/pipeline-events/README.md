# @pipeline-builder/pipeline-events

📖 **[View documentation](https://mwashburn160.github.io/pipeline-builder/)**

AWS Lambda handler for [Pipeline Builder](https://mwashburn160.github.io/pipeline-builder/) that ingests CodePipeline state-change events from EventBridge and forwards normalized payloads to the reporting service.

> Internal workspace package. This is not imported by other packages — it is deployed as a Lambda by the CLI's `setup-events` command, which provisions the full EventBridge → SQS → Lambda stack (rule, queue, dead-letter queue, IAM, and this handler).

## Responsibilities

1. Receives CodePipeline (pipeline / stage / action) events delivered as an SQS batch sourced from EventBridge.
2. Classifies each record into a normalized event type (`PIPELINE`, `STAGE`, `ACTION`) and derives status, start/completion times, run duration, and — on failures — the `errorMessage` (from the action's `execution-result.external-execution-summary`).
3. Resolves each pipeline's stable `PIPELINE_EVENT_ID` tag (applied at CDK synth = the platform `pipelineId`) via `codepipeline:ListTagsForResource`, cached per pipeline. The ARN and AWS account never leave AWS, so there is no masking/secret to manage. Untagged (unregistered) pipelines are skipped.
4. Posts the normalized batch (keyed by `pipelineId`) to the reporting service via `POST /api/reports/events`.

CodeBuild `Build State` events are skipped: a build project can be shared across pipelines, so there is no clean 1:1 mapping to a pipeline id.

## Data forwarded to the platform

The Lambda forwards **only pipeline-execution telemetry** — enough to compute
success rates, stage/action timing, and DORA metrics. It runs **inside your AWS
account**; the reporting service only ever receives the normalized payload below.

### NOT forwarded (stays in your AWS account)

- **AWS account number** — explicitly stripped from every event (`delete detail.account`).
- **The pipeline ARN** (`arn:aws:codepipeline:<region>:<account>:<name>`) — built only as a
  transient handle to look up the pipeline's `PIPELINE_EVENT_ID` tag, then discarded; it is
  never stored or sent.
- **AWS credentials / IAM** and any account-identifying identifiers.

The platform stores no AWS account id anywhere (schemas, JWTs, and APIs are account-id-free
by design), so there is nothing to mask.

### Forwarded payload (per event)

`POST /api/reports/events` with a batch of:

| Field | Type | Notes |
|---|---|---|
| `pipelineId` | string | The **platform** pipeline id (from the `PIPELINE_EVENT_ID` tag) — not the ARN |
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
| `environment` | string? | From the pipeline's `Environment` tag |
| `detail` | object | The raw CodePipeline event detail **with `account` removed** — carries the execution result (log URL, error code) for drill-down |

## Key exports

| Export | Purpose |
|---|---|
| `handler(event: SQSEvent)` | The Lambda entry point. Parses + resolves the SQS batch and POSTs normalized events to the reporting service. |

## Runtime

- Lambda Node.js runtime, using the runtime-provided `@aws-sdk/client-codepipeline`.
- Triggered by an SQS queue fed by an EventBridge rule matching the `aws.codepipeline` source; processes events in batches and POSTs them in a single request per invocation.
- Requires `PLATFORM_BASE_URL` (set by `setup-events`).
- **IAM:** the execution role must allow `codepipeline:ListTagsForResource`. An `AccessDenied` is logged as an error and fails the batch, so a missing grant is visible rather than silent.
- Authenticates with either `PLATFORM_TOKEN` (a JWT set directly) or `PLATFORM_SECRET_NAME` (a Secrets Manager secret holding `accessToken`, created via `pipeline-manager infra store-token`); the resolved token is cached across invocations.

## Development

```bash
pnpm build   # projen build (compile + lint + test + package)
pnpm test    # run the Jest test suite
```

## License

Apache-2.0. See [LICENSE](./LICENSE).
