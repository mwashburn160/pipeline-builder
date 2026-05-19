# Plan: Per-plugin drill-down

## Goal

"Click plugin X in Plugin Builds → see its build history, success rate,
duration, recent failures." Today's dashboards aggregate across all plugins.

## Critical preflight: cardinality analysis

Adding `plugin_name` as a Prometheus label on `plugin_builds_total` +
`plugin_build_duration_seconds` is the obvious approach but has hidden cost:

- Plugin count: O(100s) per org; org count: O(100s) → potentially **O(10k+) label combinations** per metric. With existing labels (`status`, `org_id`), cardinality multiplies further.
- Prometheus rule-of-thumb: aim for <10k active series per metric, with a hard ceiling around 100k before query performance degrades.
- Conclusion: per-plugin labels on **counters** are probably OK (low write rate, dies off when no builds happen). But on **histograms** (each bucket × labels) the math gets uncomfortable.

**Decision required before PR-1**: run a cardinality spike against a real
Prometheus instance with synthetic data simulating 10× and 100× the
current plugin count + org count. If counters are fine and histograms blow
up, restrict the new label to counters only and serve durations via Loki
queries (slower at query time but unlimited cardinality).

## Recommendation pending spike

Build a **two-source** drill-down:

- **Aggregate metrics** (count, success rate, p50/p95) come from Prometheus with `{plugin_name="..."}` selector — counter-only if histograms blow cardinality
- **Per-build details** (recent runs, error messages, build duration) come from Loki queries against the audit log + build queue events — unlimited cardinality, slower

## Scope (3 PRs)

### PR-D0: Cardinality spike (no merge)
- Load-test Prometheus with synthetic `plugin_builds_total{plugin_name=X, org_id=Y, status=Z}` at 10×, 100×, 1000× current scale
- Measure: ingestion rate, query latency at p95, disk usage per series
- Decision artifact: short doc saying "labels OK" or "labels not OK, fall back to Loki for X/Y/Z"
- **~0 LoC**, 1 day operational

### PR-D1: Plugin labels on counters + per-plugin overview panel
- Update `incCounter('plugin_builds_total', ...)` call sites to include `plugin_name: pluginRecord.name`
- New catalog entries: `plugin_builds_for_plugin{plugin_name="..."}`, `plugin_builds_success_rate_for_plugin{plugin_name="..."}`
- New URL params on Plugin Builds: `?plugin=<name>` — when set, all panels filter to that plugin
- Add "View plugin builds" link from main plugins list (`/dashboard/plugins`) to `/dashboard/observability/plugin-builds?plugin=<name>`
- **~250 LoC**

### PR-D2: Per-plugin recent-builds table (Loki-backed)
- Backend: add a `build.event` audit emit on every build start/complete/fail (similar to `registry.tag.*`)
- Promtail: promote `plugin_name` to a label on those events (bounded cardinality since the label only exists on build events, not all logs)
- New catalog entry: `plugin_recent_builds{plugin_name="..."}` — Loki streams
- New panel on the per-plugin filtered view: recent-builds table with timestamps + statuses + error excerpts
- **~350 LoC**

## Non-goals

- Real-time build progress streaming (already exists via SSE; not part of this dashboard)
- Per-plugin alerting (Alertmanager handles this once labels are populated — could be a follow-up)
- Per-org / per-user plugin-build reports — covered by existing /dashboard/reports
- Cross-plugin comparison view (defer until we know operators want it)

## Risks

| Risk | Mitigation |
|---|---|
| Cardinality blowup | PR-D0 spike before any code change; fall back to Loki-only if needed |
| Plugin renames break historical metrics | Accept the discontinuity; document that renaming starts a new series |
| Existing dashboards slow down (full table scans against the new label dimension) | Use `sum without (plugin_name)` in aggregate queries; let drill-down queries pay the per-plugin cost |

## Size estimate

| PR | LoC |
|---|---|
| D0 — Cardinality spike | 0 (operational) |
| D1 — Per-plugin labels + panel | 250 |
| D2 — Loki-backed recent builds | 350 |
| **Total** | **~600 LoC** across 2 implementation PRs + 1 spike |
