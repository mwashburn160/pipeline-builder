# Frontend Logs — Plan

Status: **BUILT** 2026-09-18 (uncommitted). Drafted 2026-09-17, revised after a
self-review gap pass (§7), then implemented.

Implemented: Phases 1–6 and 8 as written, under D10 = native Loki tenants.
Deferred: Phase 7 live tail (D3 chose polling first; the page refreshes on
demand rather than on an interval), saved searches (5j, optional), and
contextual deep-links from build/execution/alert pages (5g) — the `?q=` and
`trace_id` plumbing those need is in place, only the call sites are missing.

Corrections found while building, beyond the plan:
- There are **four** deploy targets, not three — `deploy/aws/ec2` also ships
  loki + promtail. All four are patched.
- `logs:export` had to be classified as a MUTATION in the frontend and refused
  server-side during read-only impersonation: the export is a GET, so the
  platform's method-based read-only gate would not have stopped it.

A Logs surface in the dashboard modeled on Grafana's Explore/Logs view — query
bar, absolute + preset time ranges, log-volume histogram, expandable per-entry
detail, raw-text view, and download-to-disk — over the Loki stack we already run.

Three hard rules, enforced server-side:

1. **Tenancy.** An org sees only its own logs; the system tenant can see any org's.
   Enforced by Loki tenant isolation, not by a filter we remember to append.
2. **Masking.** Sensitive values are masked at ingest, so they are not in storage
   to be found — plus a read-time layer for history. No unmask path.
3. **No raw query language from the browser.** The frontend sends a structured
   filter; the server compiles it.

---

## 1. What already exists

| Piece | State |
|---|---|
| Loki 3.6.11 + promtail 3.6.11 | Deployed in all three targets (`deploy/local/docker`, `deploy/local/minikube`, `deploy/aws/eks`) |
| Loki schema | `tsdb` + `schema: v13`, S3/MinIO-backed, `retention_period: 168h`, `auth_enabled: false` |
| NetworkPolicy platform → loki:3100 | **Already allowed** (`allow-loki-ingress`) — a leftover from the pre-audit-store era |
| Catalog-key indirection (no raw queries from the browser) | `platform/src/observability/catalog.ts` |
| Tenancy gate for catalog keys | `canQueryCatalogKey()` — non-`orgScoped` entries are sysadmin-only |
| Panel renderers | `frontend/src/components/observability/{Line,StackedBar,Stat,Table}Panel.tsx` |
| Ticketed single-use auth + SSE | `frontend/src/hooks/useTicketedSSE.ts` (already powers build-log streaming) |
| Streaming-proxy nginx template | `location ~ ^/api/plugin/logs/(.+)$`, `nginx.conf:224` |
| Browser download helper | `triggerBlobDownload()` / `downloadJsonl()` in `frontend/src/lib/csv-export.ts` |
| Auth'd file-download pattern | `exportOrganization()` / `fetchAttachmentBlob()` |
| Filename sanitizer | `safeName()`, `api/message/src/routes/attachment-routes.ts:51` |
| Key-based redaction (write side) | `SENSITIVE_KEY_PATTERN` + `redactSensitive()`, `packages/api-core/src/utils/logger.ts:60` |
| Key-based redaction (render side) | `redactDetails()` / `redactString()`, `frontend/src/lib/redact.ts:33` — its docstring **already names "Loki log lines/fields"** as a surface it exists to defend |
| `trace_id` on every log line | `traceIdFormat` in `packages/api-core/src/utils/logger.ts` |
| Org count metric (sizing input for D10) | `platform_orgs_total` |
| Nav slot | `frontend/src/lib/nav.ts:101` already says *"Deployments/Executions/**Logs** sit under Deliver"* — designed, never filled |

### The misnomer

`GET /api/observability/logs` exists but does **not** read Loki. It serves the
MongoDB audit trail (`platform/src/observability/audit-store-client.ts`). No code
in the repo reads Loki at all — Grafana is the only consumer today.

---

## 2. The blocking gap: log lines carry no org

Per-org anything is impossible right now because nothing attributes a line to an org.

- `packages/api-core/src/utils/logger.ts` stamps `service`, `timestamp`,
  `trace_id` — **no org**. A few call sites pass `{ orgId }` by hand
  (e.g. `api/plugin/src/queue/slot-manager.ts:143`); most don't.
- Promtail promotes `level`, `service_name`, `eventCategory`, `event`, `actor`,
  `pluginName` — **no org**.
- Promtail then does `output: { source: msg }`, which **replaces the line with
  just the message**, discarding every other JSON field.

Phase 1 fixes this, and every later phase depends on it — under either tenancy
mechanism.

---

## 3. Design

### 3.1 Tenancy: native Loki tenants

**Each org is a Loki tenant.** `auth_enabled: true`; promtail routes each line to
its org's tenant; platform sends `X-Scope-OrgID` derived from the verified token.

Chosen over filtering by an `orgId` label or structured-metadata field because a
pipeline filter cannot prune chunks: a tenant query would make Loki read *every
other org's* chunks and discard the non-matching lines, so read cost would scale
with total platform volume rather than the tenant's own. Native tenants also give
three things the filter approach cannot:

- **Physical isolation** — a query-construction bug cannot leak across orgs.
- **Per-tenant retention and rate limits** — which makes tier-aware log retention
  possible, aligning with the existing `retention_pack` / `dora_history_pack` work.
- **Per-tenant deletion** — the only practical purge path (see §6, org deletion).

Structured metadata (`orgId`) is still stamped, as a defense-in-depth second
filter and for display, but it is no longer the isolation mechanism.

**Promtail routing.** The `tenant` stage takes `source` *or* `value` (mutually
exclusive). A known pitfall: **when the source field is missing, the tenant is left
empty**, not defaulted. So:

- `clients[].tenant_id: _infra` — the default for anything unattributed.
- `tenant: { source: orgId }` guarded by a `match` selector so it only runs on
  lines that actually carry `orgId`.

Unattributed lines (startup, promtail/loki/postgres itself, background workers)
land in `_infra`, which is sysadmin-only. Tenants never see them — correct, but it
means an org's view is sparser than Grafana's. Say so in the empty state.

**Loki config, all three copies:** `auth_enabled: true`,
`multi_tenant_queries_enabled: true` (querier), `allow_structured_metadata: true`
and `max_entries_limit_per_query` set explicitly in `limits_config`, and
`deletion_mode: filter-and-delete` on the compactor for the purge path.

> Grafana's own datasource must now send `X-Scope-OrgID` too — flipping
> `auth_enabled` affects every existing client, not just ours.

### 3.2 Sysadmin cross-org reads — and an honest limit

Loki's multi-tenant read takes pipe-separated tenants —
`X-Scope-OrgID: a|b|c`, with `multi_tenant_queries_enabled: true`. **There is no
"all tenants" wildcard.**

So "the system tenant sees everything" becomes, precisely: *the system tenant can
query any org, and any set of orgs, by enumeration.* Platform owns the org list, so
it builds the header itself:

- Default view: `_infra` plus the N most recently active orgs.
- An org multi-select for explicit scoping.
- Enumerate-all up to a cap (~100 tenants per query); past the cap, selection is
  required rather than silently truncated.

This is a real trade against the filter-based design, where a sysadmin query needed
no filter at all and the firehose was free. It is worth naming: at large org counts
a true fleet-wide firehose is not practical under native tenancy, and scoped
browsing replaces it. In exchange, cross-org leakage stops being possible by
construction. **If a genuine all-orgs firehose is a hard requirement, that flips
D10.**

### 3.3 What a "log file" means here

Loki stores streams, not files. A "log file" = one `{pod, container}` stream over
the selected window.

> A pod is **multi-tenant** — one `platform` replica serves every org. So "show me
> the entire log file for this container" cannot mean the literal file for a
> tenant. Under §3.1 this is now enforced by the tenant boundary rather than a
> filter, but the semantics are the same: an org's raw view and export are that
> org's lines from that stream.

Name it honestly in the UI: *"All entries for `platform` · your organization ·
last 6h"* for a tenant, versus *"…· all selected organizations"* for a sysadmin.

### 3.4 Masking — ingest authoritative

Today's redaction is **key-based and write-time only**: winston masks
`{password: …}` in metadata. Insufficient here, for three reasons — it misses
secrets inside the message string (and after `output: source: msg` the Loki line
*is* that string), it misses non-JS producers entirely (nginx, istio, postgres),
and it cannot clean history already in Loki.

| Layer | Where | Catches | Status |
|---|---|---|---|
| L1 key-based, write-time | winston `redactFormat` | `{password: …}` metadata | exists |
| L2 value-based, write-time | new format in the logger | secrets inside our services' message strings | new |
| **L3 value-based, ingest-time** | **promtail `replace` stages** | **everything reaching storage, incl. non-JS producers** | **new — authoritative** |
| L4 value-based, read-time | platform, before serving/exporting | history written before L3 shipped | new |

**Why L3 and not L4 is the guarantee.** Read-time masking masks the *display*, but
the secret remains in Loki and remains searchable. A user searches a candidate
value; a hit confirms it even though the line renders `[REDACTED]`. Repeat, and
search becomes an oracle that recovers the secret incrementally. Masking must
therefore happen **before storage** for anything the search path can match. L4 stays
— it is the only cover for pre-L3 history — but it is a mitigation, not the
guarantee. Additionally, reject query terms that match secret patterns, closing the
oracle at both ends.

**Patterns to match by value:** JWTs (`eyJ…`), `Bearer …`, AWS access/secret keys
(`AKIA…`), session tokens, PEM blocks, connection strings with inline credentials
(`postgres://u:p@…`, `mongodb+srv://…`), `?token=` / `?api_key=` / `?sig=` query
params, Stripe keys (`sk_live_…`, `rk_…`), GitHub tokens (`ghp_…`, `gho_…`), and the
existing 12-digit AWS account-id rule from `redact.ts` (a hard repo rule).

**Single source of truth.** `SENSITIVE_KEY_PATTERN` already exists in **two**
manually-synced copies (`logger.ts:60`, `redact.ts:33`). Extract key + value
patterns into `packages/api-core/src/utils/sensitive-patterns.ts`, consumed by the
logger and the read path, and **generate the promtail `replace` stages from it** so
L3 cannot drift from L1/L2. The frontend copy stays separate (it must not import
server code) but gets a test asserting the lists match, so drift fails CI.

### 3.5 Query and filter model

**The frontend never sends LogQL.** It sends a structured filter; the server
compiles it and sets the tenant header. A small query syntax, parsed server-side:

```
level:error service:platform "connection refused" -"health check"
```

- `field:value` — allow-listed fields only (`service`, `level`, `pod`, `container`,
  `event`, `actor`, `trace_id`, `requestId`). Anything else is a parse error, never
  a pass-through.
- bare terms / `"quoted phrases"` → substring (`|=`); `-term` → exclusion (`!=`);
  `/regex/` → regex (`|~`).

**User-supplied regex is safe here**, which is worth stating because it usually
isn't: Loki is Go, and Go's `regexp` is RE2 — linear time, no backtracking, so
there is no catastrophic-backtracking DoS. Cap pattern length and filter count
anyway.

**Time range** — the existing `RangeKey` is a closed `'1h'|'6h'|'24h'` union baked
into the catalog, controller and `RangePicker`. The Loki path takes:

```ts
type TimeRange =
  | { kind: 'preset'; key: RangeKey }
  | { kind: 'absolute'; fromMs: number; toMs: number };
```

Presets stay as shortcuts; Prometheus and audit paths keep `RangeKey` untouched.
Validate `from < to`, `to` not beyond clock skew, window clamped to that tenant's
retention — clamped with a banner, not rejected.

**Org is never taken from a header.** nginx injects `x-org-id` from the JWT
(`nginx.conf:71`). The tenant header platform sends to Loki must derive from the
**verified token only**. This repo has already shipped a P0 from exactly this class
(rate-limiter header trust); pin it with a test that forges `x-org-id` and asserts
the outbound `X-Scope-OrgID` ignores it.

---

## 4. Phases

### Phase 0 — Settle D10 *(blocks everything)*

Native tenants vs. field filtering changes the promtail stage, the Loki config and
the client auth model. Input needed: expected org count (`platform_orgs_total`), and
whether a true all-orgs firehose is a hard requirement (§3.2).

### Phase 1 — Org attribution on every log line

1. **`packages/api-core/src/utils/logger.ts`** — `setLogContextProvider(fn)` plus a
   winston format stamping `orgId` / `userId` / `requestId` from the provider.
   *Why a hook and not an import:* `api-core` has no internal dependencies (verified
   across all four `package.json` files) and `tenantContext` lives in
   `pipeline-data`, which depends on `api-core`. Importing inverts the dependency.
2. **Register at boot, twice:** `packages/api-server/src/api/middleware-factory.ts`
   (covers pipeline, plugin, message, quota, billing, compliance, ask,
   image-registry) and `platform/src/index.ts` (line ~214). Both open the
   `AsyncLocalStorage` scope before any route handler.
3. **Redaction ordering** — `orgId`/`userId`/`requestId` survive `redactFormat`.
   Pin with a test: a future pattern edit that redacts `userId` would silently break
   routing.
4. **Promtail — all three copies:** extract `orgId` in the `json:` stage; add
   `structured_metadata: { orgId: }`; add the guarded `tenant:` stage and
   `clients[].tenant_id: _infra` per §3.1.

**Consequence:** existing lines have no org and land in `_infra` until this ships
and the retention window rolls. Forward-only, no backfill.

### Phase 2 — Masking pipeline

1. `packages/api-core/src/utils/sensitive-patterns.ts` — one module (keys moved from
   `logger.ts:60`, plus §3.4 value patterns, plus `maskLine()`).
2. Logger consumes it for L1 and gains L2.
3. **Generate promtail `replace` stages from that module (L3)** — the authoritative
   layer; a generator + checked-in output so config and code cannot drift.
4. Loki client applies `maskLine()` on every read path (L4).
5. Query-term rejection for secret-shaped search input (closes the oracle).
6. `redact.ts` gains a drift test against api-core's list.
7. Tests: a corpus of realistic secret-bearing lines, asserted masked through
   search **and** export, and asserted *absent from storage* after L3.

### Phase 3 — Loki read path in platform

1. **`platform/src/observability/loki-client.ts`** — modeled on
   `prometheus-client.ts`: native `fetch`, `LOKI_URL` at call time, same
   `{kind:'upstream-4xx'|'unreachable'}` error union so the controller's existing
   degraded path (200 + `degraded: true`) applies unchanged for LEAN deploys.
   Sets `X-Scope-OrgID` from the verified token. Exposes `queryRange()`,
   `queryRangeMatrix()`, `iterateRange()` (paging generator for exports).
2. **Query compiler** — `buildLogQL(filter)` per §3.5. The densest tests in the
   feature; there is no Loki-side filter to catch a mistake now that isolation is
   the tenant header.
3. **Pagination correctness** — Loki paging by timestamp double-counts or skips when
   entries share a nanosecond timestamp. Dedup on the boundary in `iterateRange()`;
   cheap now, painful to retrofit into an export people trust.
4. **Routes** on `platform/src/routes/observability.ts`, `requireAuth` +
   `requirePermission('observability:read')` (export additionally `logs:export`):
   `GET /observability/logs`, `/logs/volume`, `/logs/context`, `/logs/raw`,
   `POST /logs/export/ticket` + `GET /logs/export`.
5. **Kill switch** — a deployment flag disabling the whole surface. Loki is a shared
   component previously read only by Grafana; this points every org's dashboard at
   it, so the blast radius warrants a flag.

### Phase 4 — Volume histogram

`sum by (level) (count_over_time({<selector>}[<step>]))` through `query_range`
returns a **matrix in the shape `StackedBarPanel` already consumes**, so the chart
is nearly free. Stack by `level` rather than the reference's single green bar —
`level` is already a promoted label, so error-vs-info banding costs nothing.

### Phase 5 — The Logs page

New `frontend/pages/dashboard/logs.tsx`: query bar → histogram → entry list.

**5a. Query bar + filters.** §3.5 syntax with inline help; service / level / pod /
container dropdowns; preset + absolute time picker.

> **Facet values come from the org-scoped result set**, plus a static service list
> — not from Loki's label-values API. Under native tenancy that API is
> tenant-scoped and therefore safe, but deriving facets from results avoids a
> second code path and stays correct if D10 flips.

**5b. Entry list** — `LogsPanel.tsx`: virtualized rows, per-level colour rail (the
green/red gutter in the reference), monospace, wrap toggle, follow-tail toggle.
Org column only for sysadmins. `DataTable` has no expandable-row support, so this
is its own row component. Reuse `useServerPagination` rather than hand-rolling
scroll paging.

**5c. Entry detail** (the `>` chevron) — parsed JSON fields, labels + structured
metadata, copy line / copy as JSON, **Show context** (±N lines in the same stream),
and **View trace** — `trace_id` is already on every line, so this deep-links to
Jaeger for free.

**5d. Raw text view** — the selected stream over the current range as `text/plain`
in a `<pre>` viewer, chronological ascending, byte-capped with a truncation banner,
labelled per §3.3.

**5e. API + hooks** — `observabilityLogSearch/Volume/Context/Raw()` in
`frontend/src/lib/api/domains/observability.ts`; `useLogSearch.ts` via
`useObservabilityResource`.

**5f. Nav** — the **Deliver** section (the slot `nav.ts:101` reserves),
`requiredPermission: 'observability:read'`.

**5g. Contextual entry points** — the feature is most valuable reached *from*
something that went wrong. Deep-link `?trace_id=` / `?requestId=` / `?pod=` from
build detail, execution detail, and the alerts page. Cheap, given `trace_id` is
already stamped, and likely the difference between a feature people use and one
they remember exists.

**5h. Reconcile with build logs** — `/api/plugin/logs/:requestId` already exists
(build-log SSE, `nginx.conf:224`) with its own viewer. Either surface build logs
*through* the new viewer (filtered by `requestId`, which promtail can promote) or
name the two distinctly — "Build output" vs "Service logs". Shipping a second thing
called "Logs" without deciding will confuse people.

**5i. Embeddable panel** — `case 'logs'` in `PanelRenderer`
(`frontend/pages/dashboard/observability/[id].tsx`) and `'logs'` in the `vizKind`
union (`platform/src/services/dashboard-seeder.ts:40`).

**5j. Saved searches** *(optional)* — a named filter + range stored like dashboards.
Skip for v1 unless triage repetition justifies it.

### Phase 6 — Download

`GET /observability/logs/export?…&format=log|jsonl`, carrying a single-use ticket.

1. **Same filter, same tenant, same masking.** The export runs the *identical*
   compiled query and tenant header as the on-screen search. An org downloads only
   its own lines, masked. Not a separate code path — that is the point.
2. **Must stream, not buffer.** `query_range` caps at `max_entries_limit_per_query`.
   Export pages via `iterateRange()`, `res.write()`-ing each chunk. Buffering the
   way `organization.ts:427` does (`res.send(JSON.stringify(dump))`) would OOM.
3. **nginx must not buffer it.** `location /api/observability` (`nginx.conf:548`)
   currently sets no `proxy_buffering off` and inherits the default ~60s
   `proxy_read_timeout` — a streamed export would be buffered whole, then cut off.
   Add a dedicated location for `/api/observability/logs/(export|raw|tail)` modeled
   on `/api/plugin/logs/` (`nginx.conf:224`: `proxy_buffering off`,
   `proxy_cache off`, `chunked_transfer_encoding off`,
   `proxy_read_timeout 1800s`), plus the EKS ingress equivalent.
4. **Formats** — `.log` (masked lines, chronological) and `.jsonl` (one JSON object
   per line, labels + metadata, masked).
5. **Filename** — `<service>-<container>-<ISO date>.log` through the `safeName()`
   pattern (`attachment-routes.ts:51`). A container name reaches the
   `Content-Disposition` header; unsanitized, that is header injection.
6. **Provenance preamble** in the file: org, filter, range, generated-at, masking
   notice, truncation flag. It must be obvious from the file alone that this is a
   filtered, masked extract rather than a raw container log.
7. **Degraded path** — decide before the first byte. Once the response has started
   there is no way to signal failure except a truncation footer.
8. **Caps + accountability** — D6. Emit `observability.logs.export` with range,
   filter, format, line count and truncation flag.

### Phase 7 — Live tail

Poll `query_range` on an interval via `useObservabilityResource`, pausing on
scroll-up. If genuine tail is wanted later: `GET /observability/logs/tail` as SSE,
proxying Loki's `/loki/api/v1/tail` with the same compiled query, driven by
`useTicketedSSE` — and the Phase 6.3 nginx location already covers it.

### Phase 8 — Deploy, docs, tests

- `LOKI_URL` into platform's env in all three targets + `docs/environment-variables.md`.
- Loki config changes per §3.1 in all three copies; Grafana's datasource updated for
  `auth_enabled: true`.
- nginx / EKS ingress streaming locations (Phase 6.3).
- Verify platform → loki:3100 NetworkPolicy on **eks** and docker (minikube is
  already correct).
- Docs: `docs/observability-logs.md`; index in `docs/README.md` and
  `docs/content-index.md`; audit action in `docs/audit-events.md`; permission row in
  `docs/permissions.md:87`.
- **Loki test double** — recorded responses plus an assertion harness over emitted
  LogQL *and* the outbound tenant header. Build it before the client, not after: the
  compiler and the header are now the only things between this feature and a
  cross-tenant leak.
- Tests: forged `x-org-id` ignored; compiler rejects non-allow-listed fields; export
  reuses the search query verbatim; masking corpus absent from storage and masked on
  read; filename sanitation; absolute-range clamping; nanosecond-boundary paging;
  the Phase 1.3 redaction pin.

---

## 5. Decisions

**D1 — Endpoint naming → rename the audit one.** Move the audit-trail endpoint to
`/observability/audit-query` (its catalog source is already `audit-store`) and give
`/observability/logs` to real logs. An endpoint named "logs" that doesn't serve logs
is a trap that costs more over time than a three-call-site rename. Forward-only, no
alias.

**D2 — "System organization" → gate on `isSuperAdmin`.** `isSystemOrgId` is
documented explicitly as *"a content-owner check, not a privilege gate"*
(`packages/api-core/src/index.ts:11`), and every other observability surface uses
the claim. Org-membership gating would create a second, divergent cross-tenant
privilege path. **Note §3.2** — under native tenancy this means "can query any org",
by enumeration, not an unbounded firehose.

**D3 — Live tail → poll first.** 5s, pause on scroll-up. Add real tail later; the
`useTicketedSSE` machinery and the nginx location will already be there.

**D4 — Permissions → `observability:read` to view, new `logs:export` to
download.** Viewing reuses a permission already in `MEMBER_PERMISSIONS`
(`permissions.ts:161`), so logs light up with no role migration. Export is a
different risk class — bulk egress that leaves the building and outlives revocation
— and is exactly what an admin may want to withhold. One entry in
`ALL_PERMISSIONS`, admin bundle only.

**D5 — Download mechanism → single-use ticket + streamed URL.** The server must walk
every line anyway, and whole-stream exports are in scope, so an in-memory blob has a
ceiling we'd hit. Ticket must be single-use, short TTL (~60s), and **bound to the
exact compiled query + tenant** — otherwise it is a replayable capability someone
can paste to a colleague in another org.

**D6 — Export cap → bytes and time.** 100 MB or 60s, whichever first, truncation
line in the file, ~3 exports/hour/org. Bytes is what hurts; entry counts vary too
much to be a ceiling.

**D7 — Masking for sysadmins → yes, uniformly, no unmask path.** A privileged reveal
is a new escalation target and a standing audit problem. If a value is sensitive
enough to mask, the fix is to stop logging it, not to build a door.

**D8 — Mask at ingest or read → ingest authoritative, read as history cover.**
Revised from the earlier "read authoritative": read-time masking leaves the secret
searchable and turns search into an oracle (§3.4).

**D9 — Query language → structured syntax, compiled server-side.** Allow-listed
fields only; raw LogQL stays out of the browser. A sysadmin-only raw escape hatch is
defensible but adds a second query path to test — leave it out of v1.

**D10 — Tenancy mechanism → native Loki tenants** (§3.1), with structured metadata
retained as defense-in-depth. Open input: expected org count, and whether a true
all-orgs firehose is a hard requirement (§3.2) — that would flip this back to field
filtering and reintroduce the read-amplification and purge problems.

---

## 6. Residual risks

- **Flipping `auth_enabled` touches every Loki client**, Grafana included. It is the
  riskiest single change in the plan and should land on its own, before the read
  path.
- **Tenant count is the scaling axis** under §3.1 — per-tenant index and ingester
  memory. Size against `platform_orgs_total` before committing.
- **Redaction is now a security boundary, not hygiene.** The layers are a net, not a
  substitute for an audit pass over what services log at `info`/`debug`.
- **Org deletion** — logs hold per-org data; the purge path is a per-tenant Loki
  delete, and it needs wiring into the existing org delete-cascade work. Under field
  filtering this would have been close to unfixable.
- **Read load on a shared component** — no sizing estimate yet for every org's
  dashboard plus exports hitting Loki. The Phase 3.5 kill switch is the mitigation
  until there is one.
- **Cross-org attribution** — a request acting on org B while authenticated as org A
  (impersonation, service principals) stamps the ALS org, and now *routes the line
  to that tenant*. Under native tenancy a mistake here misfiles data permanently
  rather than merely mislabelling it. Confirm against the audit trail's
  `orgId`/`affectedOrgId` semantics before Phase 1 ships.
- **Sysadmin cross-org log reads should be audited**, not just exports — consistent
  with the direction of the impersonation-consent work.

---

## 7. Revision log

Self-review gap pass folded into the body above. What changed:

- **§3.1 / D10 (new)** — native Loki tenancy replaces structured-metadata filtering
  as the isolation mechanism. The filter approach could not prune chunks (read cost
  scaling with total platform volume, not the tenant's), could not do per-tenant
  retention, and had no practical purge path.
- **§3.2 (new)** — named the cost of that choice: no all-tenants wildcard, so
  sysadmin access is enumeration-based, not a free firehose.
- **§3.4 / D8 (revised)** — masking moved from read-authoritative to
  ingest-authoritative. Read-time masking leaves the secret searchable, making
  search an oracle that recovers it incrementally.
- **Phase 6.3** — `location /api/observability` (`nginx.conf:548`) has no
  `proxy_buffering off` and inherits ~60s; streamed export and SSE tail would break.
- **§3.5** — the `x-org-id` header-trust invariant (`nginx.conf:71`), a repeat of a
  class this repo has already shipped a P0 from.
- **§3.1** — `allow_structured_metadata`, `multi_tenant_queries_enabled`,
  `max_entries_limit_per_query`, `deletion_mode` are all unset in the deployed Loki
  config and are load-bearing.
- **Phase 5.7g/5h** — added contextual deep-links, and reconciliation with the
  existing `/api/plugin/logs/` build-log surface.
- **Phases 3.3, 3.5, 8** — nanosecond-boundary paging, a kill switch, and a Loki
  test double.
