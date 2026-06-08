# @pipeline-builder/pipeline-events

📖 **[View documentation](https://mwashburn160.github.io/pipeline-builder/)**

AWS Lambda handler for [Pipeline Builder](https://mwashburn160.github.io/pipeline-builder/) that ingests CodePipeline state-change events and forwards normalized event payloads to the platform's reporting service. Deployed automatically by `pipeline-manager setup-events`, which provisions the full EventBridge → SQS → Lambda pipeline (rule, queue, dead-letter queue, IAM, and this handler).

## What it does

1. Receives CodePipeline (pipeline / stage / action) events, delivered as an SQS batch sourced from EventBridge
2. Classifies each record into a normalized event type (`PIPELINE`, `STAGE`, `ACTION`) and derives status, start/completion times, run duration, and — on failures — the `errorMessage` (from the action's `execution-result.external-execution-summary`)
3. Resolves each pipeline's stable **`PIPELINE_EVENT_ID` tag** (applied at CDK synth = the platform `pipelineId`) via `codepipeline:ListTagsForResource`, cached per pipeline. The event is attributed to that id — **the ARN and AWS account never leave AWS**, so there is no masking/secret to manage. Events for untagged (unregistered) pipelines are skipped
4. Posts the normalized batch (keyed by `pipelineId`) to the reporting service (`POST /api/reports/events`)

CodeBuild `Build State` events are skipped: a build project can be shared across pipelines, so there is no clean 1:1 mapping to a pipeline id.

## Runtime

- Lambda Node.js runtime (uses the runtime-provided `@aws-sdk/client-codepipeline`)
- Triggered by an SQS queue fed by an EventBridge rule matching the `aws.codepipeline` source
- Processes events in batches and POSTs them in a single request per invocation
- Requires `PLATFORM_BASE_URL` (set by `setup-events`)
- **IAM:** the execution role must allow `codepipeline:ListTagsForResource`. An `AccessDenied` is logged as an error and fails the batch (so a missing grant is visible, not silent)
- Authenticates with either `PLATFORM_TOKEN` (a JWT set directly) or `PLATFORM_SECRET_NAME` (a Secrets Manager secret holding `accessToken`, created via `pipeline-manager store-token`); the resolved token is cached across invocations

## License

Apache-2.0. See [LICENSE](./LICENSE).