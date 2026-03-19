# Compliance Service

Per-organization compliance rule enforcement for pipelines and plugins.

## Features

- **Rule CRUD** — Create, read, update, delete compliance rules per org
- **Policy management** — Group rules into policies with transactional linking
- **Real-time validation** — Blocking checks on plugin upload and pipeline creation (fail-closed)
- **Published rules catalog** — System-wide rules that orgs can subscribe to
- **Rule subscriptions** — Orgs subscribe to published rules, with auto-subscribe on registration
- **Exemptions** — Per-entity rule exemptions with approval workflow
- **Compliance scans** — Re-evaluate existing entities against current rules
- **Audit logging** — Full audit trail of all compliance checks
- **Entity event evaluation** — Automatic post-mutation compliance checks via entity events
- **Rule history** — Change tracking with diff for every rule mutation

## Endpoints

### Validation (auth + org)
- `POST /compliance/validate/plugin` — Validate plugin attributes (blocking)
- `POST /compliance/validate/pipeline` — Validate pipeline attributes (blocking)
- `POST /compliance/validate/plugin/dry-run` — Pre-flight check (no audit/notification)
- `POST /compliance/validate/pipeline/dry-run` — Pre-flight check

### Rules (auth + org)
- `GET /compliance/rules` — List rules (paginated, filterable)
- `POST /compliance/rules` — Create rule
- `PUT /compliance/rules/:id` — Update rule
- `DELETE /compliance/rules/:id` — Delete rule (soft)
- `POST /compliance/rules/:id/fork` — Fork a published rule

### Policies (auth + org)
- `GET /compliance/policies` — List policies
- `POST /compliance/policies` — Create policy (with atomic rule linking)
- `PUT /compliance/policies/:id` — Update policy
- `DELETE /compliance/policies/:id` — Delete policy

### Published Rules & Subscriptions
- `GET /compliance/published-rules` — Browse published rules catalog
- `POST /compliance/subscriptions` — Subscribe to a published rule
- `DELETE /compliance/subscriptions/:ruleId` — Unsubscribe
- `POST /compliance/subscriptions/bulk` — Bulk subscribe/unsubscribe

### Internal (service-to-service)
- `POST /compliance/events/entity` — Receive entity lifecycle events for post-mutation evaluation (requires `x-internal-service: true` header)

## Caching

Active compliance rules per org+target are cached in-memory (default 60s TTL, configurable via `CACHE_TTL_COMPLIANCE_RULES`). Cache is invalidated on rule create/update/delete and when subscribed published rules change.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `CACHE_TTL_COMPLIANCE_RULES` | `60` | Rule cache TTL in seconds |
