# @pipeline-builder/pipeline-core

📖 **[View documentation](https://mwashburn160.github.io/pipeline-builder/)**

AWS CDK construct library for [Pipeline Builder](https://mwashburn160.github.io/pipeline-builder/): the `Builder` construct that assembles plugin specs into a CodePipeline stack, the `PluginLookup` custom resource that resolves plugins at deploy time, pipeline/plugin domain types, and shared application configuration. Also re-exports `pipeline-data` so consumers only depend on one package.

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

## License

Apache-2.0. See [LICENSE](./LICENSE).

---

**Keywords:** aws, codepipeline, codebuild, cicd, ci-cd, devops, cdk, aws-cdk, cloudformation, pipeline, pipeline-as-code, containerized, docker, kubernetes, plugins, typescript, self-service, multi-tenant, compliance, automation, infrastructure-as-code, iac, cli
