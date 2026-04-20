# @pipeline-builder/pipeline-core

> **Keywords:** aws, codepipeline, codebuild, cicd, ci-cd, devops, cdk, aws-cdk, cloudformation, pipeline, pipeline-as-code, containerized, docker, kubernetes, plugins, typescript, self-service, multi-tenant, compliance, automation, infrastructure-as-code, iac, cli

📖 **[View documentation](https://mwashburn160.github.io/pipeline-builder/)**

AWS CDK constructs and domain types that turn plugin specs into CodePipeline stacks. Also re-exports `pipeline-data` so consumers only depend on one package.

## Key Exports

### CDK Constructs
- `Builder` — Composable CodePipeline builder construct
- `PluginLookup` — Custom resource + Lambda that resolves plugin specs at deploy time

### Pipeline Types
- `Pipeline`, `Plugin`, `PipelineFilter`, `PluginFilter`
- `AccessModifier`, `ComputeType`, `PluginType`, `MetaDataType`

### Configuration
- `Config` — Application config loader
- `CoreConstants` — Shared timeouts, cache keys, compression thresholds
- `getConnection`, `db`, `schema` — Re-exported from `pipeline-data`

### Helpers
- `replaceNonAlphanumeric`, `extractMetadataEnv` — String utilities
- `buildPipelineConditions`, `buildPluginConditions`, `validatePipelineFilter` — Filter builders
