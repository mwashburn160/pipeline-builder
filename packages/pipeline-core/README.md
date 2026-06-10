# @pipeline-builder/pipeline-core

📖 **[View documentation](https://mwashburn160.github.io/pipeline-builder/)**

AWS CDK construct library for [Pipeline Builder](https://mwashburn160.github.io/pipeline-builder/): the `PipelineBuilder` construct that assembles plugin specs into a CodePipeline stack, the `PluginLookup` custom resource, pipeline/plugin domain types, and shared configuration.

> Internal workspace package — consumed by other packages via `workspace:*`.

## Responsibilities

- Provides the CDK constructs that synthesize a CodePipeline stack from plugin specs (`PipelineBuilder`, `StageBuilder`, `PipelineConfiguration`, `ArtifactManager`).
- Resolves plugin specs at deploy time via the `PluginLookup` custom resource.
- Hosts the synth-time template engine that parameterizes pipeline config and plugin specs.
- Owns the pipeline/plugin domain types and the environment-driven application `Config`.
- Re-exports the `pipeline-data` database layer so consumers depend on a single package for both CDK and DB access.

## Key exports

### CDK constructs
| Export | Purpose |
|---|---|
| `PipelineBuilder` | Top-level construct that assembles plugin specs into a CodePipeline stack |
| `StageBuilder` | Composes pipeline stages from plugin steps |
| `PipelineConfiguration` | Resolves and merges pipeline config metadata |
| `ArtifactManager` | Manages build artifacts across stages |
| `PluginLookup` | Custom resource that resolves plugin specs at deploy time |

### Template engine (synth-time)
| Export | Purpose |
|---|---|
| `tokenize`, `hasTemplate` | Parse template strings into tokens |
| `resolve`, `resolveString`, `dependencies`, `lookupPath` | Evaluate expressions and report dependencies |
| `resolveTemplates`, `resolveSelfReferencing` | Walk a document and resolve string fields in place |
| `walkAndBind`, `topoSort`, `validateTemplates`, `TokenCache` | Field binding, dependency ordering, validation, and token caching |

### Domain types & config
| Export | Purpose |
|---|---|
| `Config`, `ConfigTypes` | Environment-driven application config singleton and typed interfaces |
| `PipelineType`, `ComputeType`, `AccessModifier`, `PluginType` | Pipeline domain enums |
| `SourceTypes`, `StepTypes`, `NetworkTypes`, `RoleTypes`, `SecurityGroupTypes` | Pipeline source/step and infrastructure type definitions |
| `IdGenerator`, `replaceNonAlphanumeric`, `extractMetadataEnv` | ID generation and string/metadata helpers |
| `buildConfigFromMetadata`, `metadataForCodePipeline`, `metadataForShellStep`, … | Metadata builders |

### Re-exported from `pipeline-data`
`db`, `getConnection`, `closeConnection`, `schema`, `CrudService`, `runMigrations`, the tenant-context primitives (`tenantContext`, `runWithTenantContext`, `withTenantTx`), the query condition builders/filters, and `drizzleRows` / `drizzleCount`.

## Usage

```typescript
import { PipelineBuilder, Config } from '@pipeline-builder/pipeline-core';

const config = Config.getInstance();

new PipelineBuilder(this, 'Pipeline', {
  // plugin specs + pipeline config resolved into a CodePipeline stack
});
```

## Development

```bash
pnpm build   # projen build (compile + lint + test + package)
pnpm test    # run the Jest test suite
```

## License

Apache-2.0. See [LICENSE](./LICENSE).
