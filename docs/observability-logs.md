# Logs

Application logs from every Pipeline Builder service, searchable in the
dashboard at **Deliver → Logs** (`/dashboard/logs`).

Distinct from the **audit trail** (`/dashboard/audit`), which records *who did
what*. These are the services' own log lines.

---

## What you can see

| You are | You see |
|---|---|
| A member of an organization | Only lines your organization produced |
| A system administrator | The `_infra` tenant by default; any organization, or several, by selecting them |

Isolation is enforced by Loki itself, not by a filter in the query: every
organization is a separate Loki **tenant**, and the tenant header is derived
server-side from your verified token. An organization cannot read another's
lines even if a query is malformed.

**Lines with no organization** — service startup, background workers, nginx,
Postgres, Loki itself — belong to the `_infra` tenant and are visible only to
system administrators. This is why your organization's view is sparser than a
raw container log: infrastructure noise is not yours.

**A pod is shared.** One `platform` replica serves every organization, so "the
whole log file for this container" is not something an organization can be
shown. The raw view and the download give you *your* lines from that stream, and
say so in the file.

---

## Searching

The search box takes a small syntax, compiled server-side. You never write
LogQL, and raw queries are not accepted from the browser — that indirection is
what makes the surface safe to expose per-tenant.

```
level:error service_name:platform "connection refused" -healthz /timed? out/
```

| Form | Meaning |
|---|---|
| `field:value` | Exact match on an allow-listed field |
| `"quoted phrase"` or a bare word | The line contains this text |
| `-term` | The line does **not** contain this text |
| `/regex/` | The line matches this regular expression |

Fields: `service_name`, `service`, `level`, `pod`, `container`, `event`,
`eventCategory`, `actor`, `pluginName`, `orgId`, `trace_id`, `requestId`.
An unrecognized field is an error rather than a silently ignored filter.

Regular expressions are safe to use freely: Loki evaluates them with RE2, which
is linear-time and has no catastrophic-backtracking failure mode.

### Time range

Presets (15m / 1h / 6h / 24h / 7d), or an absolute range. Clicking a bar in the
volume histogram zooms to that bucket. Logs are retained for **7 days**; a wider
request is narrowed to that window with a banner rather than rejected.

---

## Reading an entry

Expand a row (the `›` chevron) for its parsed fields, stream labels and
structured metadata, plus:

- **Copy line** / **Copy as JSON**
- **Show context** — the lines either side of it in the same stream
- **View trace** — every line carries `trace_id`, so you can jump straight to the
  distributed trace

**View as text** renders the current selection as a plain-text extract.

---

## Downloading

**.log** (plain text) or **.jsonl** (one JSON object per line, labels preserved).

The download runs the *same* compiled query, tenant scope and masking as the
search on screen — it is not a separate path, so you get exactly what you can
see. Each file opens with a preamble recording the organization, filter, window
and masking notice.

Requires the **`logs:export`** permission, which is separate from viewing:
viewing rides `observability:read` (in the built-in Member role), while export
is granted to admins and owners by default. Bulk egress leaves the building and
outlives a revoked session, so an organization can withhold it from ordinary
members while still letting them read logs on screen.

Exports are capped at 100 MB or 60 seconds, whichever comes first, and a
truncated file says so on its last line. Every export is recorded in the audit
trail as `observability.logs.export`. Export is refused during a read-only
impersonation session.

---

## Masking

Credential-shaped values are replaced with `[REDACTED]` **before they are
stored**, and again on the way out.

Masked: JWTs, `Bearer` tokens, AWS access keys, Stripe / GitHub / Slack tokens,
credentials embedded in connection strings and URLs, `?token=`-style query
parameters, inline `secret=` assignments, private-key headers, and AWS account
identifiers.

Masking at ingest — not only at read time — is deliberate. Masking only the
display would leave the value in storage and still matchable, so searching for a
guess and seeing whether it hit would confirm the secret even though the line
renders as `[REDACTED]`. For the same reason, **a search term that looks like a
credential is rejected**.

Masking is not a licence to log secrets. It is a net under the rule that
services should not log them in the first place.

---

## Operating

| Setting | Where | Note |
|---|---|---|
| `LOKI_URL` | platform env | Defaults to `http://loki:3100` |
| `LOKI_BASE_SELECTOR` | platform env | Anchor matcher when no label is constrained; defaults to `service_name=~".+"` |
| `auth_enabled: true` | `deploy/shared/config/loki/loki-config.yml` | Per-organization tenancy. **Every** Loki client must then send `X-Scope-OrgID`, Grafana included |
| `multi_tenant_queries_enabled: true` | same | Lets an admin read several tenants in one query |
| `allow_structured_metadata: true` | same | Required, or Loki rejects the `orgId` metadata promtail attaches |
| `deletion_mode: filter-and-delete` | same | Enables per-tenant deletion when an organization is removed |
| `retention_period: 168h` | same | 7 days, platform-wide |

Log tenancy depends on `orgId` reaching promtail. The logger stamps it from the
request's tenant scope (`setLogContextProvider`, wired once in api-server's
`tenant-context.ts`), promtail promotes it to structured metadata and routes the
line with its `tenant` stage. A line written outside a request scope has no
`orgId` and goes to `_infra` — fail-closed by construction.

The ingest-time masking stages are **generated**, not hand-written:

```bash
node scripts/gen-promtail-masking.mjs          # print the block
node scripts/gen-promtail-masking.mjs --check  # CI: fail if a config drifted
```

They come from `packages/api-core/src/utils/sensitive-patterns.ts`, the single
source shared with the logger and the read path.

If Loki is unreachable (a LEAN deployment omits it), the pages render an empty
state with a banner rather than an error.
