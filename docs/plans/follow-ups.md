# Plan: follow-up prioritization

Ordered backlog across all open plans in this directory plus the
deferred items from the May 2026 code-review sweep
(`frontend/`, `platform/`, `api/`, `packages/`, `deploy/`).

Ranking criteria, in order:
1. **Likelihood of biting us soon** — green-yesterday-red-today incidents
   come first
2. **Defense-in-depth wins with bounded risk** — security hardening that
   needs care but doesn't gate features
3. **Operator value** — features that materially improve the on-call
   experience
4. **Optional / demand-gated** — things to defer until a real signal arrives

---

## P0 — CI hygiene, ships next

These are sub-day fixes that prevent the same incident class from
recurring. The Frontend Dockerfile pattern bit us once (jest 30.4.x
resolved instead of the lockfile's 30.3.0, `_moduleMocker.clearMocksOnScope
is not a function`); every other subproject's Dockerfile has the same
shape.

### F-0.1 — Pin `jestVersion` across all projen-managed subprojects (~50 LoC `.projenrc.ts`)
- Frontend done; replicate the `jestOptions.jestVersion: '30.3.0'` pin
  in every `*Project()` that has `jest: true`
- Subprojects to touch: `api/quota`, `api/pipeline`, `api/plugin`,
  `api/billing`, `api/compliance`, `api/reporting`, `api/image-registry`,
  `platform`, `packages/api-core`, `packages/api-server`,
  `packages/pipeline-data`, `packages/pipeline-core`, etc.
- Regenerate via `pnpm dlx projen`, commit the resulting `package.json` deltas
- **Why first**: same caret-range trap; will fire in CI the next time
  a service's Docker image is rebuilt during a jest 30.4.x window

### F-0.2 — Sweep test files for the jsdom-env trap (~1 hour audit)
- `useDarkMode.test.ts` and `favorites.test.ts` were written for the
  node test env but ran under jsdom (the project default). Their
  `globalThis.window = …` stubs silently no-op'd because jsdom's
  `window` was already bound — tests passed by accident or leaked state.
- Audit pattern: `grep -rl 'globalThis.*window\|globalThis.*localStorage' frontend/test/`
- Each match: either add `@jest-environment node` block comment at the
  top of the file, or rewrite to use jsdom's bindings directly
  (`Object.defineProperty(window, 'localStorage', …)`)
- **Likely 3–5 more files**; cheap to do as a batch

### F-0.3 — Dockerfile lockfile copy pattern (~100 LoC across Dockerfiles)
- Per-service Dockerfiles copy only `package.json` and run `pnpm install`,
  so caret-range deps resolve to "latest at build time" — every transient
  dep version drift becomes a "why is CI red today" mystery
- Fix: copy the workspace `pnpm-lock.yaml` + relevant `pnpm-workspace.yaml`
  into the build context and run `pnpm install --frozen-lockfile`
- Less invasive alternative: F-0.1 alone closes the immediate case;
  this is the systemic fix
- **Defer if F-0.1 absorbs all the version-drift risk in practice**

---

## P1 — Security hardening, ships in parallel

Single-purpose PRs with well-understood scope. Each lands defense in
depth without gating features.

### F-1.1 — k8s + Fargate workload hardening
- See [`k8s-fargate-hardening.md`](k8s-fargate-hardening.md) for the
  full plan: 4 PRs, ~900 LoC YAML, ~3 weeks with soak windows
- Order: plugin pod → registry pod → nginx pod → Fargate tasks
- **Why P1, not P0**: no known live exploit. Defense-in-depth that
  needs per-workload validation; no CI urgency.

### F-1.2 — Per-org rate-limit on observability endpoints (~150 LoC)
- Flagged in `db-stored-dashboards.md`'s risks table ("bad operator-built
  queries DOS Prometheus") but applies today: any authenticated user can
  hit `/api/observability/query` repeatedly and DoS upstream
- Add `express-rate-limit` per-org bucket; tune to ~30 queries/min
- **Cheap to ship**; recommended before alerting work since alert rules
  also hit the same Prom instance

---

## P2 — Operator value, ships when capacity allows

Real feature work; ~1 sprint each.

### F-2.1 — Alerting (Prometheus Alertmanager)
- See [`alerting.md`](alerting.md): 4 PRs, ~1100 LoC, ~2 weeks
- **Highest operator value** in the queue; currently zero paging
- Blocks: F-1.2 should land first so the alert rules themselves don't
  contribute to DoS pressure on Prom

### F-2.2 — Per-plugin drill-down
- See [`per-plugin-drilldown.md`](per-plugin-drilldown.md): 2 PRs + a
  spike, ~600 LoC
- **Blocked on PR-D0 spike** (cardinality analysis). Until that runs,
  decisions on Prom-vs-Loki for the metric backing are speculative
- Order after F-2.1 because alerting will reveal which per-plugin
  metrics operators actually care about (and therefore what the
  drill-down should lead with)

---

## P3 — Demand-gated, defer until signal arrives

### F-3.1 — DB-stored editable dashboards
- See [`db-stored-dashboards.md`](db-stored-dashboards.md): 4 PRs,
  ~2000 LoC, ~4–6 weeks
- Plan itself recommends deferring until 2 of 3 demand signals arrive
  (operator requests a missing panel; someone hand-edits the static
  dashboards; per-org customization becomes a customer ask)
- **Today: zero signals**; revisit quarterly

---

## Cross-cutting carryover from code reviews

Logged here so they don't get lost; small enough to bundle into the
next PR that touches the file.

- `frontend/src/hooks/useRepositoryList.ts:63` — `loadMore()` lacks a
  `loading` guard; rapid clicks fire duplicate page requests. Currently
  mitigated by consumer button gating, but cheap to gate at hook level.
- `frontend/src/components/pipeline/EditPipelineModal.tsx:113` — wizard
  step/preview state survives a re-open inside the 1.5 s success-close
  window. Mitigated in practice (parent unmounts/remounts), but the
  intra-window reopen path is unguarded.
- `deploy/bin/backup.sh` — now `eval`-free; consider adding `set -euo
  pipefail` since the unsafe-arg risk is gone.

---

## What's intentionally not on the list

- **`init-secrets.sh` echoing passwords**: design-intent one-time display;
  changing it breaks the operator UX.
- **`chmod 644` on TLS / JWT private keys in startup scripts**: user
  preference per the deploy review; keys are immediately uploaded as
  k8s Secrets so on-disk perms aren't the security boundary.
- **CDK sample placeholder account IDs / VPC IDs**: AWS-sample convention;
  obviously-fake values are load-bearing for readability.
- **Switching plugin Dockerfiles from `curl | sh` to checksummed installs**:
  these are vendor-canonical install scripts (pyenv, sdkman, golangci-lint);
  diverging from upstream guidance is more risk than the supply-chain
  win at this scale.
