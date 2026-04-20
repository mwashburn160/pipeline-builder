# @pipeline-builder/pipeline-data

📖 **[View documentation](https://mwashburn160.github.io/pipeline-builder/)**

Database layer for [Pipeline Builder](https://mwashburn160.github.io/pipeline-builder/) — a self-service platform that turns TypeScript, a YAML config, or a single AI prompt into a production-ready AWS CodePipeline backed by 124 reusable, containerized plugins.

Provides Drizzle ORM schemas, connection management, query builders, and the generic `CrudService` base class with built-in multi-tenant access control used by every backend service.

## Key Exports

### Connection
- `getConnection`, `db` — Shared PostgreSQL pool and Drizzle client
- `ConnectionRetryStrategy` — Retry logic for transient connection failures

### Schemas
- `schema` — All Drizzle table definitions (pipeline, plugin, compliance, events, …)
- Entity types: `Pipeline`, `Plugin`, `ComplianceRule`, `PipelineEvent`, `Message`

### CrudService
- `CrudService<TEntity, TFilter, TInsert, TUpdate>` — Abstract base providing `find`, `findById`, `create`, `update`, `delete`, `findPaginated`, plus per-entity lifecycle hooks and multi-tenant access control
- `FilterBuilder` — Type-safe pagination/sort/filter builder

### Query Builders
- `BaseQueryBuilder` — Generic insert/update/delete
- `pipelineBuilder`, `pluginBuilder` — Entity-specific query helpers

### Helpers
- `withTimestamps`, `softDelete` — Common column decorators

## License

Apache-2.0. See [LICENSE](./LICENSE).

---

**Keywords:** aws, codepipeline, codebuild, cicd, ci-cd, devops, cdk, aws-cdk, cloudformation, pipeline, pipeline-as-code, containerized, docker, kubernetes, plugins, typescript, self-service, multi-tenant, compliance, automation, infrastructure-as-code, iac, cli
