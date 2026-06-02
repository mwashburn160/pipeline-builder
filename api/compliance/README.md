# Compliance Service

Per-organization compliance rule enforcement for pipelines and plugins.

## Features

- **Rule CRUD** — Create, read, update, delete compliance rules per org
- **Rule engine** — Field-level conditions with operators over dot-notation paths, plus computed fields (`$count`, `$length`, `$keys`, `$lines`) and length-capped regex matching; results separate blocking violations from non-blocking warnings by severity (`warning`, `error`, `critical`)
- **Policy management** — Group rules into policies with transactional linking
- **Real-time validation** — Blocking checks on plugin upload and pipeline creation (fail-closed); super-admins are exempt
- **Dry-run validation** — Pre-flight checks against caller-supplied attributes with no audit log or notification side effects
- **Published rules catalog** — System-wide rules that orgs can browse and subscribe to
- **Rule subscriptions** — Orgs subscribe to published rules (inactive by default), activate/deactivate them, and bulk-toggle up to 100 at once; auto-subscribe runs at org onboarding
- **Version pinning** — Pin a subscription to a specific rule version, or unpin to track the latest
- **Rule cloning** — Copy a published rule into org scope as an independent, editable rule
- **Impact preview** — Evaluate a rule against the org's existing plugins/pipelines before enabling it, with aggregate pass/fail counts and sample failing entities
- **Exemptions** — Per-entity rule exemptions with approval workflow, bulk creation, and self-approval guard
- **Compliance scans** — Re-evaluate existing entities against current rules, with concurrency control, progress tracking, and cancellation
- **Scheduled scans** — Cron-style scan schedules that can be activated, paused, and deleted
- **Rule templates** — Pre-built rule definitions an org can apply to bootstrap its policy set
- **Audit logging** — Full audit trail of all compliance checks, with daily retention-based pruning
- **Entity event evaluation** — Automatic post-mutation compliance checks driven by a Redis/BullMQ-backed event queue
- **Rule history** — Change tracking with diff for every rule mutation

## Endpoints

### Validation (auth + org)
- `POST /compliance/validate/plugin` — Validate plugin attributes (blocking)
- `POST /compliance/validate/pipeline` — Validate pipeline attributes (blocking)
- `POST /compliance/validate/plugin/dry-run` — Pre-flight check (no audit/notification)
- `POST /compliance/validate/pipeline/dry-run` — Pre-flight check

### Rules (auth + org)
- `GET /compliance/rules` — List rules (paginated, filterable)
- `GET /compliance/rules/:id` — Get a single rule
- `GET /compliance/rules/:id/history` — Rule change history with diffs
- `POST /compliance/rules` — Create rule
- `PUT /compliance/rules/:id` — Update rule
- `DELETE /compliance/rules/:id` — Delete rule (soft)

### Policies (auth + org)
- `GET /compliance/policies` — List policies
- `POST /compliance/policies` — Create policy (with atomic rule linking)
- `PUT /compliance/policies/:id` — Update policy
- `DELETE /compliance/policies/:id` — Delete policy

### Published Rules & Subscriptions (auth + org)
- `GET /compliance/published-rules` — Browse published rules catalog (paginated, filterable; includes subscription status for the caller)
- `GET /compliance/subscriptions` — List the org's subscriptions with rule details
- `GET /compliance/subscriptions/enforced` — Merged view of all enforced rules (org rules + active subscriptions)
- `POST /compliance/subscriptions` — Subscribe to a published rule (starts inactive)
- `PATCH /compliance/subscriptions/:ruleId` — Activate or deactivate a subscription
- `POST /compliance/subscriptions/bulk` — Bulk activate/deactivate up to 100 subscriptions
- `POST /compliance/subscriptions/auto-subscribe` — Subscribe the org to all published rules (used at onboarding)
- `POST /compliance/subscriptions/clone` — Clone a published rule into an independent org-scoped rule
- `POST /compliance/subscriptions/preview` — Preview a rule against caller-supplied sample attributes
- `POST /compliance/subscriptions/preview/impact` — Preview a rule against the org's existing entities (pass/fail counts + samples)
- `POST /compliance/subscriptions/:ruleId/pin` — Pin a subscription to the current rule version
- `DELETE /compliance/subscriptions/:ruleId/pin` — Unpin a subscription (track latest version)
- `DELETE /compliance/subscriptions/:ruleId` — Unsubscribe

### Exemptions (auth + org)
- `GET /compliance/exemptions` — List exemptions
- `POST /compliance/exemptions` — Request an exemption
- `POST /compliance/exemptions/bulk` — Bulk-create exemptions
- `PUT /compliance/exemptions/:id/review` — Approve or reject an exemption (self-approval guarded)
- `DELETE /compliance/exemptions/:id` — Revoke an exemption

### Scans & Schedules (auth + org)
- `GET /compliance/scans` — List scans
- `GET /compliance/scans/:id` — Get scan status/results
- `POST /compliance/scans` — Start a scan re-evaluating existing entities
- `POST /compliance/scans/:id/cancel` — Cancel a running scan
- `GET /compliance/scan-schedules` — List scan schedules
- `POST /compliance/scan-schedules` — Create a scan schedule
- `PUT /compliance/scan-schedules/:id` — Update a scan schedule
- `PATCH /compliance/scan-schedules/:id/active` — Activate or pause a schedule
- `DELETE /compliance/scan-schedules/:id` — Delete a schedule

### Templates & Audit (auth + org)
- `GET /compliance/templates` — List rule templates
- `POST /compliance/templates/apply` — Apply a template to create org rules
- `GET /compliance/audit` — Query the compliance audit log

### Internal (service-to-service)
- `POST /compliance/events/entity` — Receive entity lifecycle events for post-mutation evaluation. Callers must present a valid service-principal JWT (minted via `getServiceAuthHeader`); the route enforces `requireAuth` + `requireServicePrincipal`, so a plain HTTP header is not sufficient.

## Caching

Active compliance rules per org+target are cached in-memory (default 60s TTL, configurable via `CACHE_TTL_COMPLIANCE_RULES`). Cache is invalidated on rule create/update/delete and when subscribed published rules change.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `CACHE_TTL_COMPLIANCE_RULES` | `60` | Rule cache TTL in seconds |
| `COMPLIANCE_AUDIT_RETENTION_DAYS` | `180` | Days of audit log retained before daily pruning |
| `COMPLIANCE_MAX_ATTRIBUTE_KEYS` | `100` | Max top-level keys allowed in a validation payload (DoS guard) |
| `COMPLIANCE_MAX_ATTRIBUTE_DEPTH` | `10` | Max nesting depth allowed in a validation payload (DoS guard) |
| `COMPLIANCE_MAX_REGEX_LENGTH` | `100` | Max length of a user-supplied regex pattern in a rule (ReDoS guard) |
| `COMPLIANCE_SCAN_CONCURRENCY` | `10` | Number of entities evaluated in parallel during a scan |
| `COMPLIANCE_SCAN_PROGRESS_BATCH_SIZE` | `10` | How often scan progress is flushed (entities per batch) |
| `REDIS_HOST` | `redis` | Redis host for the BullMQ entity-event queue |
| `REDIS_PORT` | `6379` | Redis port for the BullMQ entity-event queue |
