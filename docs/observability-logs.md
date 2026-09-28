---
layout: default
title: Logs
---

<!--
Copyright 2026 Pipeline Builder Contributors
SPDX-License-Identifier: Apache-2.0
-->

# Logs

Application logs from every Pipeline Builder service, searchable in the dashboard at **Deliver → Logs** (`/dashboard/logs`).

## Highlights

- **Isolation is enforced by Loki, not by a query filter.** Every organization is a separate Loki *tenant*, and the tenant header is derived server-side from your verified token — a malformed query cannot cross the boundary.
- **You never write LogQL.** A small search syntax is compiled server-side; raw queries from the browser are refused. That indirection is what makes the surface safe to expose per-tenant.
- **Credentials are masked before they are stored**, not just on display — and a search term that looks like a credential is rejected.
- **Export is a separate permission** (`logs:export`) from viewing (`observability:read`), because bulk egress leaves the building and outlives a revoked session.
- **Retention is 7 days**, platform-wide. A wider request is narrowed with a banner rather than rejected.
- **Not the audit trail.** `/dashboard/audit` records *who did what*; these are the services' own log lines.

## Overview

This page is the per-organization window onto the platform's own application logs. A member sees only the lines their organization produced; a system administrator can additionally read the shared infrastructure tenant and span several organizations at once.

It is for two audiences: developers debugging their own pipelines and plugins, and operators standing up or tuning the logging stack. If you want the *audit* record of an action rather than a service's log line, see [Audit Events](audit-events.md).

## How it works

1. **A service logs a line** inside a request scope. The logger stamps the line with the request's `orgId` from the tenant scope (`setLogContextProvider`, wired once in api-server's `tenant-context.ts`).
2. **Masking runs at ingest.** Credential-shaped values are replaced with `[REDACTED]` before the line is stored — and again on the way out.
3. **Promtail routes the line.** It promotes `orgId` to structured metadata and uses its `tenant` stage to send the line to that organization's Loki tenant.
4. **A line with no `orgId` goes to `_infra`.** Anything written outside a request scope — service startup, background workers, nginx, Postgres, Loki itself — lands in the infrastructure tenant, visible only to system administrators. This is fail-closed by construction.
5. **A search compiles to LogQL server-side.** Your filter is parsed, validated against the field allow-list, and combined with the tenant header taken from your token.
6. **Loki answers within its tenant only.** The organization scope is a property of the request to Loki, not a clause in the query.

### Why your view is sparser than a raw container log

Infrastructure noise is not yours. And because **a pod is shared** — one `platform` replica serves every organization — "the whole log file for this container" is not something an organization can be shown. The raw view and the download give you *your* lines from that stream, and say so in the file.

### Why masking happens at ingest

Masking only the display would leave the real value in storage and still matchable. Someone could search for a guess and learn from whether it hit, confirming the secret even though the line renders as `[REDACTED]`. Masking at write time closes that, and is also why a search term that looks like a credential is refused outright.

Masking is a net under the rule that services should not log secrets in the first place — not a licence to log them.

## Configuration

### Platform settings

| Setting | Where | Note |
|---|---|---|
| `LOKI_URL` | platform env | Defaults to `http://loki:3100` |
| `LOKI_BASE_SELECTOR` | platform env | Anchor matcher when no label is constrained; defaults to `service_name=~".+"` |

### Loki settings

All four live in each target's `config/loki/loki-config.yml`.

| Setting | Why it is required |
|---|---|
| `auth_enabled: true` | Turns on per-organization tenancy. **Every** Loki client must then send `X-Scope-OrgID`, Grafana included |
| `multi_tenant_queries_enabled: true` | Lets an administrator read several tenants in one query |
| `allow_structured_metadata: true` | Required, or Loki rejects the `orgId` metadata promtail attaches |
| `deletion_mode: filter-and-delete` | Enables per-tenant deletion when an organization is removed |
| `retention_period: 168h` | 7 days, platform-wide |

### Steps

1. **Set `auth_enabled: true`** in the target's `loki-config.yml`, along with the other three Loki settings above. Tenancy does not work without it.
2. **Point every Loki client at a tenant.** With auth on, any client that does not send `X-Scope-OrgID` is refused — including Grafana.
3. **Confirm `orgId` reaches promtail.** Tenancy depends on it: the logger stamps it, promtail promotes it to structured metadata and routes on it. Lines missing it silently become `_infra` lines.
4. **Regenerate the masking stages** rather than hand-editing them:

   ```bash
   node scripts/gen-promtail-masking.mjs          # print the block
   node scripts/gen-promtail-masking.mjs --check  # CI: fail if a config drifted
   ```

   They are generated from `packages/api-core/src/utils/sensitive-patterns.ts`, the single source shared with the logger and the read path.
5. **Grant `logs:export` deliberately.** Viewing rides `observability:read`, which the built-in Member role already has; export is granted to admins and owners by default so an organization can let members read logs on screen while withholding bulk egress.

If Loki is unreachable — a LEAN deployment omits it — the pages render an empty state with a banner rather than an error.

## What you can see

| You are | You see |
|---|---|
| A member of an organization | Only lines your organization produced |
| A system administrator | The `_infra` tenant by default; any organization, or several, by selecting them |

## Searching

```
level:error service_name:platform "connection refused" -healthz /timed? out/
```

| Form | Meaning |
|---|---|
| `field:value` | Exact match on an allow-listed field |
| `"quoted phrase"` or a bare word | The line contains this text |
| `-term` | The line does **not** contain this text |
| `/regex/` | The line matches this regular expression |

**Allow-listed fields:** `service_name`, `service`, `level`, `pod`, `container`, `event`, `eventCategory`, `actor`, `pluginName`, `orgId`, `trace_id`, `requestId`. An unrecognized field is an error rather than a silently ignored filter.

Regular expressions are safe to use freely: Loki evaluates them with RE2, which is linear-time and has no catastrophic-backtracking failure mode.

### Time range

Presets (15m / 1h / 6h / 24h / 7d), or an absolute range. Clicking a bar in the volume histogram zooms to that bucket. Because retention is 7 days, a wider request is narrowed to that window with a banner.

## Reading an entry

Expand a row (the `›` chevron) for its parsed fields, stream labels and structured metadata, plus:

- **Copy line** / **Copy as JSON**
- **Show context** — the lines either side of it in the same stream
- **View trace** — every line carries `trace_id`, so you can jump straight to the distributed trace

**View as text** renders the current selection as a plain-text extract.

## Downloading

Two formats: **.log** (plain text) or **.jsonl** (one JSON object per line, labels preserved).

The download runs the *same* compiled query, tenant scope and masking as the search on screen — it is not a separate path, so you get exactly what you can see. Each file opens with a preamble recording the organization, filter, window and masking notice.

| Property | Value |
|---|---|
| Permission | `logs:export` (separate from viewing) |
| Cap | 100 MB or 60 seconds, whichever comes first |
| Truncation | A truncated file says so on its last line |
| Audit | Recorded as `observability.logs.export` |
| Impersonation | Refused during a read-only impersonation session |

## What gets masked

JWTs, `Bearer` tokens, AWS access keys, Stripe / GitHub / Slack tokens, credentials embedded in connection strings and URLs, `?token=`-style query parameters, inline `secret=` assignments, private-key headers, and AWS account identifiers.

## Related

- [Audit Events](audit-events.md) — the tamper-evident record of who did what
- [Permissions](permissions.md) — `observability:read` and `logs:export`
- [Environment Variables](environment-variables.md) — `LOKI_URL`, `LOKI_BASE_SELECTOR`
