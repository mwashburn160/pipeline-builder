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

## Key exports

| Export | Purpose |
|---|---|
| `handler(event: SQSEvent)` | The Lambda entry point. Parses + resolves the SQS batch and POSTs normalized events to the reporting service. |

## Runtime

- Lambda Node.js runtime, using the runtime-provided `@aws-sdk/client-codepipeline`.
- Triggered by an SQS queue fed by an EventBridge rule matching the `aws.codepipeline` source; processes events in batches and POSTs them in a single request per invocation.
- Requires `PLATFORM_BASE_URL` (set by `setup-events`).
- **IAM:** the execution role must allow `codepipeline:ListTagsForResource`. An `AccessDenied` is logged as an error and fails the batch, so a missing grant is visible rather than silent.
- Authenticates with either `PLATFORM_TOKEN` (a JWT set directly) or `PLATFORM_SECRET_NAME` (a Secrets Manager secret holding `accessToken`, created via `pipeline-manager store-token`); the resolved token is cached across invocations.

## Development

```bash
pnpm build   # projen build (compile + lint + test + package)
pnpm test    # run the Jest test suite
```

## License

Apache-2.0. See [LICENSE](./LICENSE).
