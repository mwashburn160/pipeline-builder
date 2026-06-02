# @pipeline-builder/pipeline-events

📖 **[View documentation](https://mwashburn160.github.io/pipeline-builder/)**

AWS Lambda handler for [Pipeline Builder](https://mwashburn160.github.io/pipeline-builder/) that ingests CodePipeline and CodeBuild state-change events and forwards normalized event payloads to the platform's reporting service. Deployed automatically by `pipeline-manager setup-events`, which provisions the full EventBridge → SQS → Lambda pipeline (rule, queue, dead-letter queue, IAM, and this handler).

## What it does

1. Receives CodePipeline (pipeline / stage / action) and CodeBuild build-state events, delivered as an SQS batch sourced from EventBridge
2. Classifies each record into a normalized event type (`PIPELINE`, `STAGE`, `ACTION`, `BUILD`) and derives status, start/completion times, and run duration
3. Hashes account IDs in ARNs (SHA-256, matching `api-core`'s `mask-helpers`) so downstream storage never sees raw account numbers
4. Posts the normalized batch to the reporting service (`POST /api/reports/events`)

## Runtime

- Lambda Node.js runtime
- Triggered by an SQS queue fed by an EventBridge rule matching `aws.codepipeline` and `aws.codebuild` sources
- Processes events in batches and POSTs them in a single request per invocation
- Requires `PLATFORM_BASE_URL` (set by `setup-events`)
- Authenticates with either `PLATFORM_TOKEN` (a JWT set directly) or `PLATFORM_SECRET_NAME` (a Secrets Manager secret holding `accessToken`, created via `pipeline-manager store-token`); the resolved token is cached across invocations

## License

Apache-2.0. See [LICENSE](./LICENSE).