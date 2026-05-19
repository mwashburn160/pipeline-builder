# Plan: DB-stored editable dashboards

## Goal

Replace the code-defined dashboards (`frontend/src/lib/dashboards/*.ts`)
with user-editable dashboards stored in postgres. Operators add panels,
change layouts, save per-org defaults.

## Why this is big

This is the biggest follow-up on the roadmap (~2000 LoC, multi-PR). What
it adds:

- DB schema for dashboards + panels + layout
- CRUD endpoints
- Migration of existing static dashboards into DB-seeded defaults
- Drag-resize layout editor UI
- Panel-add modal (pick query + viz from the catalog)
- Save / revert / clone flows
- Per-org dashboard visibility + permissions (who can edit vs. view)
- Migration tooling to import/export dashboard JSON

## Recommendation: defer until demand is proven

The current static dashboards (5 today: Platform Overview, Plugin Builds,
Queue Health, Registry Activity, Audit Activity) cover the operator
workflows we've identified. Building the editor before there's clear
operator demand risks:

- Months of work for low real-world adoption
- A complex CRUD + RBAC + layout-editor surface to maintain
- Operators editing dashboards into degraded states (bad queries, broken
  layouts) that on-call has to recover from

**Wait until at least 2 of these happen:**
1. Operators ask for a dashboard panel that's not in any of the 5 we ship
2. Someone files an issue saying "I had to clone the repo + edit code to
   change my dashboard"
3. Per-org / per-team customization becomes a real customer ask (e.g.,
   "we want a panel showing our team's plugin uptake")

Until then, **add panels via PR** — fast turnaround (a few hours), no
state to migrate, no editor to maintain.

## When the time comes — implementation sketch

### PR-E1: Schema + CRUD endpoints (~600 LoC)
- `dashboards` table: `id, org_id, name, description, layout_json, created_by, created_at, updated_at, visibility (private|org|public)`
- `dashboard_panels` table: `id, dashboard_id, query_key, viz_kind, title, span, group_by, format, position`
- Migration: seed the 5 existing dashboards as `visibility=public` rows
- Endpoints:
  - `GET /api/dashboards` — list visible to caller (per-org + public)
  - `GET /api/dashboards/:id` — fetch one
  - `POST /api/dashboards` — create (org-admin or above)
  - `PUT /api/dashboards/:id` — update layout / panels (creator or org admin)
  - `DELETE /api/dashboards/:id` — delete
  - `POST /api/dashboards/:id/clone` — fork into your own org
- Each endpoint enforces `requireAuth + isOrgAdmin || isSysAdmin` for writes; read is `requireAuth`

### PR-E2: Read path — DB-backed dashboard pages (~400 LoC)
- New page `/dashboard/observability/[id]` — fetches dashboard from API, renders panels
- Existing static dashboard pages remain (back-compat); add a deprecation banner saying "this dashboard is now editable at /dashboard/observability/<id>"
- Sidebar nav: list user's accessible dashboards (org's + public) instead of hardcoded 5

### PR-E3: Edit path — drag-resize editor (~700 LoC)
- Pull `react-grid-layout` or equivalent into devDeps (significant — ~120kB)
- New page `/dashboard/observability/[id]/edit` — drag-resize layout, add/remove panels
- Panel-add modal: dropdown of catalog query keys + viz picker + title
- Save → `PUT /api/dashboards/:id`; Discard → revert local state
- Per-edit autosave (or explicit Save button — pick)

### PR-E4: Migration + import/export (~300 LoC)
- `pnpm dlx pipeline-manager dashboard export <id>` → JSON file
- `pnpm dlx pipeline-manager dashboard import <file>` → POST to API
- CI step: snapshot all `visibility=public` dashboards into `deploy/<target>/seeds/dashboards/` so a fresh deploy starts with curated defaults

## Non-goals

- Variable substitution beyond what the catalog supports (`$ORG`, `$EVENT`, etc.)
- Real-time collaborative editing (two users editing the same dashboard)
- Panel-level access control (whole-dashboard visibility only)
- Panel marketplace / cross-org sharing
- Dashboard versioning / history (use git-tracked JSON exports for that need)

## Risks

| Risk | Mitigation |
|---|---|
| Editor takes months to build before operators value it | Don't start until the demand signal is real |
| Bad operator-built queries DOS Prometheus | Rate-limit per-org observability endpoints (already a follow-up — PR-7 in the main plan) |
| Schema churn after launch | Use JSONB for layout to keep migrations simple |
| `react-grid-layout` bundle cost | Lazy-load the edit page so view-only pages don't pay the cost |

## Size estimate

| PR | LoC |
|---|---|
| E1 — Schema + CRUD | 600 |
| E2 — Read path | 400 |
| E3 — Editor | 700 |
| E4 — Migration tools | 300 |
| **Total** | **~2000 LoC** across 4 PRs over ~4-6 weeks |
