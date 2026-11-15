# quota

Per-organization quota tracking and enforcement for the pipeline-builder platform. Stores each org's tier, limits, and usage counters, and exposes the increment/decrement primitives other services use to reserve and release quota. The API gateway (nginx) routes `/api/quota/*` here, rewriting to the service's internal `/quotas/*` paths.

## Responsibilities

- Holds per-org quota documents (limits + usage per type) keyed by `orgId`, seeded from tier presets (Mongo-backed).
- Answers quota lookups for the org's own quotas, a specific org (with authorization), and a single quota type. A team (an org with a parent) and a root with teams report the ROOT's pooled caps against the whole account's usage; enforcement is one atomic pooled counter on the root.
- Operator views (`orgs:read`, system org only): all orgs with quotas, and an "at-risk" scan of accounts over a usage threshold, evaluated by pool (memoized).
- Operator limit/name/slug/tier updates, usage resets, and a cascade-delete hook (`quotas:manage`, system org, aal2); billing's entitlement sync writes limits through its own internal route. Internal-only `increment`/`decrement` endpoints back the reserve-then-rollback pattern used by gated actions, and the METERED form of `increment` (`meter: true`) applies a pod's batched apiCalls/automationCalls with partial admission (excess recorded as overshoot).
- A usage ledger (hourly buckets of counted / denied / overshoot / refunded units, by principal, route, pipeline, AI feature and model) behind "what used this quota", 80% / 100% threshold notices (inbox, email, optional webhook; storage via a leader-locked sweep), and the account's optional AI controls (per-member share, token budget).
- Quota types are sourced from `@pipeline-builder/api-core` (e.g. `plugins`, `pipelines`, `apiCalls`, `automationCalls` (org service accounts and personal access keys — counted instead of `apiCalls`, soft cap via `QUOTA_AUTOMATION_GRACE_PCT`), `aiCalls`, `storageBytes`, `dashboards`, `alertRules`, `alertDestinations`, `idpConfigs`).

## Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/quotas` | The caller's own org quotas (orgId from JWT) |
| GET | `/quotas/all` | All orgs with quotas (`orgs:read`, system org) |
| GET | `/quotas/at-risk` | Accounts at/above a usage threshold, default 80% (`orgs:read`, system org) |
| GET | `/quotas/internal/:orgId/profile` | Per-dimension usage + projection for the expansion-offers profile (internal: billing) |
| GET | `/quotas/:orgId` | All quotas for a specific org (authorized) |
| GET | `/quotas/:orgId/at-risk` | One org's at-risk dimensions (authorized, `quotas:read`) |
| GET | `/quotas/:orgId/usage` | Usage-ledger breakdown, JSON or CSV (authorized, `quotas:read`) |
| GET | `/quotas/:orgId/own-usage` | The org's own, unpooled numbers (internal: billing) |
| GET | `/quotas/:orgId/notice-settings` | The account's notice settings + AI controls (authorized, `quotas:read`) |
| PUT | `/quotas/:orgId/notice-settings` | Update them, on the account root only (`billing:manage`) |
| GET | `/quotas/:orgId/:quotaType` | Status for a single quota type (authorized) |
| PUT | `/quotas/:orgId` | Update name / slug / tier / limits (`quotas:manage`, system org, aal2) |
| PUT | `/quotas/entitlement-sync/:orgId` | Billing's entitlement sync (internal: billing) |
| DELETE | `/quotas/:orgId` | Cascade-delete an org's quota doc, idempotent (`quotas:manage`, system org, aal2, step-up) |
| POST | `/quotas/:orgId/reset` | Reset usage counters (`quotas:manage`, system org, aal2, step-up) |
| POST | `/quotas/:orgId/increment` | Reserve usage, apply a metered batch (`meter: true`), or record an AI usage report (`report: true`) (internal service-to-service) |
| POST | `/quotas/:orgId/decrement` | Roll back a reserved increment (internal service-to-service) |

## Configuration

| Variable | Purpose | Default |
|----------|---------|---------|
| `PORT` | HTTP listen port | `3000` |
| `MONGODB_URI` | MongoDB connection string (required) | — |
| `QUOTA_RESET_DAYS` | Usage-counter reset period in days (`cpuCredits` is monthly regardless) | `3` |
| `QUOTA_AT_RISK_CACHE_TTL_MS` | TTL for the `/quotas/at-risk` scan cache | `60000` |
| `QUOTA_POOL_FALLBACK_TTL_MS` | How long a resolved pooled cap serves as the fallback when a later resolution fails (`0` = a failure denies teams) | `60000` |
| `QUOTA_USAGE_EVENT_RETENTION_DAYS` | Usage-ledger retention (TTL indexes; read at index build) | `90` |
| `QUOTA_THRESHOLD_NOTICES_ENABLED` | Send the 80% / 100% notices at all | `true` |
| `QUOTA_STORAGE_USAGE_CACHE_TTL_MS` | TTL for a registry storage-usage reading | `60000` |
| `QUOTA_STORAGE_SWEEP_ENABLED` | Run the storage notice sweep | `true` |
| `QUOTA_STORAGE_SWEEP_INTERVAL_HOURS` / `_STARTUP_DELAY_MS` / `_LOCK_TTL_MS` / `_MAX_ORGS` | Sweep cadence, first-run delay, leader-lock TTL, orgs per pass | `6` / `120000` / leader-lock default / `200` |
| `QUOTA_STORAGE_NOTICE_REMINDER_DAYS` | Window after which a still-full account is reminded | `7` |
| `DEFAULT_PLAN_TIER`, `PLAN_TIER_<TIER>_<LIMIT>` | Tier presets (read by api-core; echoed at startup) | api-core presets |
| `QUOTA_DEFAULT_<TYPE>` (e.g. `QUOTA_DEFAULT_API_CALLS`) | Limit for an org with no tier preset — the unprovisioned-org fallback read. One per quota type; does not change the cap a provisioned org is held to | the `developer` tier preset |

## Development

Builds on the shared core packages (`@pipeline-builder/api-core`, `@pipeline-builder/api-server`, `@pipeline-builder/pipeline-core`). Project files are generated by projen from `.projenrc.ts`.

```sh
pnpm build   # compile + lint + test
pnpm test    # run tests
pnpm start   # run the compiled service (node lib/index.js)
```

## License

Apache-2.0
