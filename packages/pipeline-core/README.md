# @pipeline-builder/pipeline-core

📖 **[View documentation](https://mwashburn160.github.io/pipeline-builder/)**

AWS CDK construct library for [Pipeline Builder](https://mwashburn160.github.io/pipeline-builder/): the `PipelineBuilder` construct that assembles plugin specs into a CodePipeline stack, the `PluginLookup` custom resource that resolves plugins at deploy time, a synth-time template engine for parameterizing pipeline config, pipeline/plugin domain types, and shared application configuration. Also re-exports `pipeline-data` so consumers depend on a single package for both the CDK layer and database access.

## Key Exports

### CDK Constructs
- `PipelineBuilder` — Top-level CodePipeline builder construct
- `StageBuilder` — Composes pipeline stages from plugin steps
- `PipelineConfiguration` — Resolves and merges pipeline config metadata
- `ArtifactManager` — Manages build artifacts across stages
- `PluginLookup` — Custom resource + Lambda that resolves plugin specs at deploy time

### Template Engine
- `tokenize`, `resolve`, `dependencies` — Synth-time templating for pipeline config and plugin specs
- `walkAndBind`, `topoSort`, `TokenCache` — Field binding, dependency ordering, and token caching

### Pipeline Types
- `SourceType`, `TriggerType`, `MetadataKeys` — Pipeline source and metadata types
- `PipelineFilter`, `PluginFilter`, `PluginSecret` — Re-exported from `pipeline-data`
- `AccessModifier`, `ComputeType`, `PluginType`, `MetaDataType` — Domain enums

### Configuration
- `Config` — Application config loader (environment-driven singleton)
- `CoreConstants` — Shared timeouts, cache keys, secret paths, and limits
- `getConnection`, `closeConnection`, `db`, `schema` — Database access, re-exported from `pipeline-data`
- `tenantContext`, `runWithTenantContext`, `withTenantTx` — Postgres RLS tenant-context primitives
- `runMigrations` — Idempotent migration runner for service startup

### Helpers
- `replaceNonAlphanumeric`, `extractMetadataEnv` — String and metadata utilities
- `buildConfigFromMetadata`, `metadataForCodePipeline`, `metadataForShellStep` — Metadata builders
- `buildPipelineConditions`, `buildPluginConditions` — Filter builders re-exported from `pipeline-data`
- `CrudService`, `drizzleRows`, `drizzleCount` — CRUD infrastructure and Drizzle type helpers

## License

Apache-2.0. See [LICENSE](./LICENSE).