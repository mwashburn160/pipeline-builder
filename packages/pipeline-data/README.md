# @pipeline-builder/pipeline-data

📖 **[View documentation](https://mwashburn160.github.io/pipeline-builder/)**

Database layer for [Pipeline Builder](https://mwashburn160.github.io/pipeline-builder/): Drizzle ORM schemas, connection management, query builders, and the generic `CrudService` base class with built-in multi-tenant access control used by every backend service.

## Key Exports

### Connection
- `getConnection`, `db`, `closeConnection` — Shared PostgreSQL pool, Drizzle client, and lifecycle management
- `dbReplica` — Optional read-replica client for read-heavy queries (reporting, listings)
- `ConnectionRetryStrategy` — Retry logic for transient connection failures
- `runMigrations` — Drizzle migration runner

### Schemas
- `schema` — All Drizzle table definitions: core pipeline/plugin/message tables, the pipeline deployment registry and execution-event log, observability dashboards and per-org alerting, plus the full compliance suite (policies, rules, exemptions, audit log, scans, reports)
- Entity types: `Pipeline`, `Plugin`, `Message`, `PipelineEvent`, `ComplianceRule`, and a matching `*Insert` / `*Update` type for each table

### CrudService
- `CrudService<TEntity, TFilter, TInsert, TUpdate>` — Abstract base providing `find`, `findById`, `findPaginated`, `count`, `create`, `update`, `delete` (soft delete), `setDefault`, and `updateMany`
- Built-in multi-tenant access control and pagination; subclasses implement `buildConditions` and a few column accessors and inherit the rest
- Optional per-entity lifecycle hooks fire after mutations (e.g. cache invalidation)

### Query Builders & Access Control
- `AccessControlQueryBuilder` — Row-level, org-scoped condition builder enforcing tenant isolation and `accessModifier` visibility
- `buildPipelineConditions`, `buildPluginConditions`, `buildMessageConditions`, and the compliance condition builders — filter-to-SQL translators used by the services
- Tenancy helpers: `tenantContext`, `runWithTenantContext`, `withTenantTx` — `AsyncLocalStorage`-backed tenant scoping for transactions

### Reporting
- `ReportingService` / `reportingService` — Aggregate-query base for pipeline event ingestion and org-scoped reporting

## License

Apache-2.0. See [LICENSE](./LICENSE).