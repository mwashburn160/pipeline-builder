# compliance

Per-organization compliance rule enforcement for pipelines and plugins — authors and evaluates rules, gates entity mutations in real time, and re-scans existing entities asynchronously.

## Responsibilities

- **Rules & policies** — org-scoped CRUD over compliance rules (field-level conditions with operators, computed fields, severity) and the policies that group them.
- **Real-time validation** — blocking checks on plugin uploads and pipeline creation (fail-closed; super-admins exempt), plus side-effect-free dry runs.
- **Published catalog & subscriptions** — system-wide published rules orgs can browse, subscribe to, version-pin, clone, and preview impact before enabling.
- **Exemptions** — per-entity rule exemptions with an approval workflow.
- **Scans & schedules** — re-evaluate existing entities against current rules on demand or on a cron schedule, with concurrency control, progress tracking, and cancellation.
- **Audit log** — records every compliance check; pruned daily on a retention window.
- **Async re-validation** — consumes entity lifecycle events (from the plugin/pipeline services) off a BullMQ/Redis queue and re-evaluates affected entities under each event's tenant scope.

Built on the shared core packages: `@pipeline-builder/api-core` (auth, quota, response helpers), `@pipeline-builder/api-server` (app factory, request context), and `@pipeline-builder/pipeline-core` (config, tenant context). Requires Redis for the event queue.

## Endpoints

The service listens on port `3000`. The API gateway (nginx) routes `/api/compliance/*` here, rewriting to the internal `/compliance/*` paths below.

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/compliance/validate/{plugin\|pipeline}` | Blocking compliance check (with audit + notify) |
| POST | `/compliance/validate/{plugin\|pipeline}/dry-run` | Pre-flight check, no side effects |
| GET/POST | `/compliance/rules` | List / create rules |
| GET/PUT/DELETE | `/compliance/rules/:id` | Get / update / delete a rule |
| GET | `/compliance/rules/:id/history` | Rule version history |
| GET | `/compliance/published-rules` | Browse the published rules catalog |
| GET | `/compliance/subscriptions` | List the org's subscriptions |
| POST | `/compliance/subscriptions` | Subscribe to a published rule |
| POST | `/compliance/subscriptions/bulk` | Bulk activate/deactivate subscriptions |
| POST | `/compliance/subscriptions/auto-subscribe` | Auto-subscribe at org onboarding |
| POST | `/compliance/subscriptions/clone` | Clone a published rule into org scope |
| GET | `/compliance/subscriptions/enforced` | List enforced (active) subscriptions |
| POST | `/compliance/subscriptions/preview` | Preview a rule against sample attributes |
| POST | `/compliance/subscriptions/preview/impact` | Preview a rule's impact on existing entities |
| PATCH/DELETE | `/compliance/subscriptions/:ruleId` | Set active / unsubscribe |
| POST/DELETE | `/compliance/subscriptions/:ruleId/pin` | Pin / unpin a subscription to a rule version |
| GET/POST | `/compliance/policies` | List / create policies |
| GET/PUT/DELETE | `/compliance/policies/:id` | Get / update / delete a policy |
| GET/POST | `/compliance/exemptions` | List / create exemptions |
| POST | `/compliance/exemptions/bulk` | Bulk-create exemptions |
| PUT | `/compliance/exemptions/:id/review` | Approve/reject an exemption |
| DELETE | `/compliance/exemptions/:id` | Delete an exemption |
| GET/POST | `/compliance/scans` | List / start scans |
| GET | `/compliance/scans/:id` | Get scan status |
| POST | `/compliance/scans/:id/cancel` | Cancel a running scan |
| GET/POST | `/compliance/scan-schedules` | List / create scan schedules |
| PUT | `/compliance/scan-schedules/:id` | Update a schedule |
| PATCH | `/compliance/scan-schedules/:id/active` | Activate/pause a schedule |
| DELETE | `/compliance/scan-schedules/:id` | Delete a schedule |
| GET | `/compliance/templates` | List rule templates |
| POST | `/compliance/templates/apply` | Apply a template to bootstrap rules |
| GET | `/compliance/audit` | Query the compliance audit log |
| POST | `/compliance/events/entity` | Internal entity-event receiver (service-principal JWT only) |

## Configuration

Shared server/auth/DB/Redis settings (`PORT`, `JWT_SECRET`, `DB_*`, `REDIS_HOST`, `REDIS_PORT`, `PLATFORM_BASE_URL`) are read via `@pipeline-builder/pipeline-core`. Env vars read directly by this service:

| Variable | Purpose | Default |
|----------|---------|---------|
| `REDIS_HOST` | Redis host for the event queue | `redis` |
| `REDIS_PORT` | Redis port for the event queue | `6379` |
| `COMPLIANCE_AUDIT_RETENTION_DAYS` | Days to retain audit-log rows before the daily prune | `180` |
| `COMPLIANCE_MAX_ATTRIBUTE_KEYS` | Max attribute keys accepted on a validate request | `100` |
| `COMPLIANCE_MAX_ATTRIBUTE_DEPTH` | Max nesting depth of validate-request attributes | `10` |
| `COMPLIANCE_MAX_REGEX_LENGTH` | Cap on user-supplied regex length in rule conditions | unset (no cap) |
| `COMPLIANCE_SCAN_CONCURRENCY` | Concurrent entity evaluations per scan | `10` |
| `COMPLIANCE_SCAN_PROGRESS_BATCH_SIZE` | Entities per scan-progress update | `10` |

## Development

```bash
pnpm build   # projen build (compile + test + package)
pnpm compile # tsc only
pnpm test    # jest
pnpm watch   # incremental compile
```

Routes delegate to per-resource services (rule, policy, exemption, scan, scan-schedule, subscription, audit). On startup the service registers the BullMQ event-queue backend, starts the compliance worker and scan scheduler, and schedules the daily audit prune; all are torn down on graceful shutdown.

## License

Apache-2.0
