# @pipeline-builder/pipeline-data

📖 **[View documentation](https://mwashburn160.github.io/pipeline-builder/)**

Database layer for [Pipeline Builder](https://mwashburn160.github.io/pipeline-builder/): Drizzle ORM schemas, connection management, query builders, and the generic `CrudService` base class with per-organization (and team) access control.

> Internal workspace package — consumed by other packages via `workspace:*`.

## Responsibilities

- Defines the Drizzle ORM schema for every backend table (pipelines, plugins, messages, pipeline events, and the compliance suite).
- Manages the PostgreSQL connection lifecycle with retry logic.
- Provides the generic `CrudService` base class with built-in multi-tenant (org/team) access control and pagination.
- Supplies filter-to-SQL query/condition builders and `AsyncLocalStorage`-backed tenant-context primitives for transactions.
- Hosts the `ReportingService` used to ingest pipeline events and serve org-scoped reporting.

## Key exports

### Database
| Export | Purpose |
|---|---|
| `db` | Shared Drizzle database instance |
| `getConnection`, `closeConnection` | PostgreSQL connection lifecycle (with retry strategy) |
| `schema` | All Drizzle table definitions and their `*Insert` / `*Update` types |
| `runMigrations` (`MigrateOptions`) | Drizzle migration runner |
| `tenantContext`, `runWithTenantContext`, `getTenantContext`, `withTenantTx` | Tenant-context primitives for scoped/RLS transactions |

### Services
| Export | Purpose |
|---|---|
| `CrudService<TEntity, TFilter, TInsert, TUpdate>` | Abstract base providing `find`, `findById`, `findPaginated`, `count`, `create`, `update`, `delete` (soft), `setDefault`, `updateMany` with multi-tenant access control |
| `ReportingService` / `reportingService` | Aggregate-query base for pipeline-event ingestion and org-scoped reporting |

### Query builders & filters
| Export | Purpose |
|---|---|
| `AccessControlQueryBuilder` | Row-level, org-scoped condition builder enforcing tenant isolation and `accessModifier` visibility |
| `buildPipelineConditions`, `buildPluginConditions`, `buildMessageConditions`, and the compliance condition builders | Filter-to-SQL translators used by the services |
| `PipelineFilter`, `PluginFilter`, `MessageFilter`, the compliance filter types | Typed filter interfaces |
| `drizzleRows`, `drizzleCount` | Drizzle result type helpers |

## Usage

```typescript
import { CrudService, db, schema } from '@pipeline-builder/pipeline-data';

class PipelineService extends CrudService<Pipeline, PipelineFilter, PipelineInsert, PipelineUpdate> {
  // implement buildConditions + a few column accessors; inherit the rest
}
```

## Development

```bash
pnpm build   # projen build (compile + lint + test + package)
pnpm test    # run the Jest test suite
```

## License

Apache-2.0. See [LICENSE](./LICENSE).
