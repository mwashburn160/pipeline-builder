# compliance

Per-organization compliance rule enforcement for pipelines and plugins — authors and evaluates rules, gates entity mutations in real time, and re-scans existing entities asynchronously.

## Responsibilities

- **Rules & policies** — org-scoped CRUD over compliance rules (field-level conditions with operators, computed fields, severity) and the policies that group them.
- **Real-time validation** — blocking checks on plugin uploads and pipeline creation (fail-closed; super-admins exempt), plus side-effect-free dry runs.
- **Published catalog & subscriptions** — system-wide published rules orgs can browse, subscribe to, version-pin, clone, and preview impact before enabling.
- **Exemptions** — per-entity rule exemptions with a two-person approval workflow (the requester cannot approve), a daily expiry sweep with a pre-expiry warning, and re-request of a rejected or expired exemption.
- **Scans & schedules** — re-evaluate existing entities against current rules on demand or on a cron schedule, with concurrency control, progress tracking, and cancellation.
- **Audit log** — records every compliance check; pruned daily on a retention window (with finished scans and the notification log).
- **Entitlements & posture** — internal billing → compliance sync that activates the curated content sets an account is entitled to (and deactivates the rest), and a read-only posture summary for stakeholder reports.
- **Notifications** — alerts orgs on blocks (and, opt-in, warnings) via the in-app inbox, email (delegated to the platform service, which resolves recipients), and HMAC-signed webhooks; per-org preferences gate severity/channels, with immediate or daily/weekly digests flushed by a Redis-leader-locked scheduler (so only one replica delivers).
- **Async re-validation** — receives entity lifecycle events from the plugin/pipeline services over an internal HTTP route (signed service tokens, retried with an idempotency key) and re-evaluates the entity under the event's tenant scope.

Built on the shared core packages: `@pipeline-builder/api-core` (auth, quota, response helpers), `@pipeline-builder/api-server` (app factory, request context), and `@pipeline-builder/pipeline-core` (config, tenant context). Postgres is the hard dependency; Redis is used fail-open only (token-revocation reads and the schedulers' leader locks).

## Endpoints

The service listens on port `3000`. The API gateway (nginx) routes `/api/compliance/*` here, rewriting to the `/compliance/*` paths below — except `/api/compliance/internal/*`, which the gateway refuses (404): the `/compliance/internal/*` routes are service-to-service only.

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/compliance/validate/{plugin\|pipeline}` | Blocking compliance check (with audit + notify) |
| POST | `/compliance/validate/{plugin\|pipeline}/dry-run` | Pre-flight check, no side effects |
| GET/POST | `/compliance/rules` | List / create rules |
| GET/PUT/DELETE | `/compliance/rules/:id` | Get / update / delete (soft) a rule |
| GET | `/compliance/rules/deleted` | The org's soft-deleted rules |
| POST | `/compliance/rules/:id/restore` | Restore a soft-deleted rule (step-up) |
| POST | `/compliance/rules/:id/purge` | Permanently delete a soft-deleted rule (step-up) |
| GET | `/compliance/rules/:id/history` | Rule version history |
| GET | `/compliance/published-rules` | Browse the published rules catalog |
| GET | `/compliance/subscriptions` | List the org's subscriptions |
| POST | `/compliance/subscriptions` | Subscribe to a published rule |
| POST | `/compliance/subscriptions/bulk` | Bulk activate/deactivate subscriptions |
| POST | `/compliance/subscriptions/clone` | Clone a published rule into org scope |
| GET | `/compliance/subscriptions/enforced` | List enforced (active) subscriptions |
| POST | `/compliance/subscriptions/preview` | Preview a rule against sample attributes |
| POST | `/compliance/subscriptions/preview/impact` | Preview a rule's impact on existing entities |
| PATCH/DELETE | `/compliance/subscriptions/:ruleId` | Set active / unsubscribe |
| POST/DELETE | `/compliance/subscriptions/:ruleId/pin` | Pin / unpin a subscription to a rule version |
| GET/POST | `/compliance/policies` | List / create policies |
| GET/PUT/DELETE | `/compliance/policies/:id` | Get / update / delete (soft) a policy |
| GET | `/compliance/policies/deleted` | The org's soft-deleted policies |
| POST | `/compliance/policies/:id/restore` | Restore a soft-deleted policy (step-up) |
| POST | `/compliance/policies/:id/purge` | Permanently delete a soft-deleted policy (step-up) |
| GET/POST | `/compliance/exemptions` | List / create exemptions |
| POST | `/compliance/exemptions/bulk` | Bulk-create exemptions |
| PUT | `/compliance/exemptions/:id/review` | Approve/reject an exemption |
| PUT | `/compliance/exemptions/:id/expiry` | Extend an approved exemption's expiry before it lapses (same reviewer rules as approval) |
| DELETE | `/compliance/exemptions/:id` | Delete an exemption |
| GET/POST | `/compliance/scans` | List / start scans |
| GET | `/compliance/scans/:id` | Get scan status |
| POST | `/compliance/scans/:id/cancel` | Cancel a running scan |
| GET/POST | `/compliance/scan-schedules` | List / create scan schedules |
| PUT | `/compliance/scan-schedules/:id` | Update a schedule |
| PATCH | `/compliance/scan-schedules/:id/active` | Activate/pause a schedule |
| DELETE | `/compliance/scan-schedules/:id` | Deactivate a schedule (soft delete) |
| GET | `/compliance/templates` | List rule templates |
| POST | `/compliance/templates/apply` | Apply a template to bootstrap rules |
| GET | `/compliance/audit` | Query the compliance audit log |
| GET/PUT | `/compliance/notification-preferences` | Read / upsert the org's notification preference (PUT is org-admin; webhook secret never returned) |
| POST | `/compliance/internal/subscriptions/auto-subscribe` | Internal auto-subscribe at org onboarding (`platform` service token only) |
| POST | `/compliance/internal/events/entity` | Internal entity-event receiver (`pipeline` / `plugin` service tokens only; the body `orgId` must match the token org; the parent org is resolved server-side and the audit actor is the calling service) |
| PUT/GET | `/compliance/internal/entitlements/:orgId` | Internal billing entitlement sync / drift read (`billing` service token only) |
| GET | `/compliance/internal/posture` | Internal posture counts for stakeholder reports (`reporting` service token only) |

## Configuration

Shared server/auth/DB settings (`PORT`, `DB_*`, `PLATFORM_BASE_URL`) are read via `@pipeline-builder/pipeline-core`; Redis (`REDIS_URL` or `REDIS_SENTINELS`) via `@pipeline-builder/api-core`. Env vars specific to this service:

| Variable | Purpose | Default |
|----------|---------|---------|
| `COMPLIANCE_AUDIT_RETENTION_DAYS` | Days to retain audit-log rows before the daily prune | `180` |
| `COMPLIANCE_MAX_ATTRIBUTE_KEYS` | Max attribute keys accepted on a validate request | `100` |
| `COMPLIANCE_MAX_ATTRIBUTE_DEPTH` | Max nesting depth of validate-request attributes | `10` |
| `COMPLIANCE_MAX_REGEX_LENGTH` | Cap on user-supplied regex length in rule conditions (authoring hygiene; the ReDoS bound is the match timeout) | `100` |
| `COMPLIANCE_REGEX_TIMEOUT_MS` | Wall-clock bound on one rule regex match | `50` |
| `COMPLIANCE_NOTIFY_TIMEOUT_MS` | Per-channel notification delivery timeout | `5000` |
| `COMPLIANCE_EXEMPTION_EXPIRY_WARN_DAYS` | How far ahead an org is warned of a lapsing exemption | `7` |
| `COMPLIANCE_SCAN_CONCURRENCY` | Concurrent entity evaluations per scan | `10` |
| `COMPLIANCE_SCAN_PROGRESS_BATCH_SIZE` | Entities per scan-progress update | `10` |
| `COMPLIANCE_SCAN_ENTITY_PAGE_SIZE` | Entities fetched per page during a scan | `1000` |
| `COMPLIANCE_SCAN_ENTITY_MAX_TOTAL` | Per-target entity bound; a larger org's scan fails rather than truncates | `100000` |
| `COMPLIANCE_SCAN_STALE_TIMEOUT_MS` | A `running` scan older than this is marked failed | `7200000` |
| `SCAN_SCHEDULER_INTERVAL_MS` | Scan scheduler tick interval (ms) | `60000` |
| `SCAN_LOCK_TTL_MS` | Scan scheduler cross-pod leader-lock TTL (ms) | `120000` |
| `DIGEST_SCHEDULER_INTERVAL_MS` | Notification digest scheduler tick interval (ms) | `3600000` |
| `DIGEST_LOCK_TTL_MS` | Digest scheduler cross-pod leader-lock TTL (ms) | `120000` |
| `PLATFORM_SERVICE_HOST` | Platform service host for email delivery | `platform` |
| `PLATFORM_SERVICE_PORT` | Platform service port | `3000` |

## Development

```bash
pnpm build   # projen build (compile + test + package)
pnpm compile # tsc only
pnpm test    # jest
pnpm watch   # incremental compile
```

Routes delegate to per-resource services (rule, policy, exemption, scan, scan-schedule, subscription, audit). On startup the service starts the scan scheduler, the digest scheduler, the daily audit prune, the exemption-expiry sweep and the soft-delete retention purge; all are torn down on graceful shutdown.

## License

Apache-2.0
