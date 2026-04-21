# @pipeline-builder/event-ingestion

📖 **[View documentation](https://mwashburn160.github.io/pipeline-builder/)**

AWS Lambda handler for [Pipeline Builder](https://mwashburn160.github.io/pipeline-builder/) that ingests CodePipeline state-change events from EventBridge and forwards normalized event payloads to the platform's reporting service. Deployed automatically by `pipeline-manager setup-events`.

## What it does

1. Receives a CodePipeline stage/action/execution event from EventBridge
2. Hashes account IDs in ARNs so downstream storage never sees raw account numbers
3. Posts a normalized event payload to the reporting service (`/reports/events`)

## Runtime

- Lambda Node.js runtime
- Triggered by EventBridge rule on `aws.codepipeline` source
- Requires `REPORTING_SERVICE_URL` and `PLATFORM_TOKEN` env vars (set by `setup-events`)

## License

Apache-2.0. See [LICENSE](./LICENSE).

---

**Keywords:** aws, codepipeline, codebuild, cicd, ci-cd, devops, cdk, aws-cdk, cloudformation, pipeline, pipeline-as-code, containerized, docker, kubernetes, plugins, typescript, self-service, multi-tenant, compliance, automation, infrastructure-as-code, iac, cli
