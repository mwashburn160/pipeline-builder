# Plan: follow-up prioritization (post-P1+P2)

Ordered backlog across all open plans in this directory plus the
deferred items from the May 2026 code-review sweep and the May 19 P1+P2
implementation push.

Ranking criteria, in order:
1. **Likelihood of biting us soon** — green-yesterday-red-today incidents
   come first
2. **Defense-in-depth wins with bounded risk** — security hardening that
   needs care but doesn't gate features
3. **Operator value** — features that materially improve the on-call
   experience
4. **Optional / demand-gated** — things to defer until a real signal arrives

---

## What just shipped (May 2026)

So the rest of this doc isn't relitigating closed work:

- ✅ **k8s plugin / registry / nginx hardening** — `runAsNonRoot`,
  `readOnlyRootFilesystem`, `seccompProfile: RuntimeDefault`, `drop: ["ALL"]`
  on both minikube and aws/ec2 manifests. Nginx swapped to
  `nginxinc/nginx-unprivileged:1.27`.
- ✅ **Fargate ECS hardening** — `ReadonlyRootFilesystem: true` + ephemeral
  `/tmp` volumes on 10 of 11 task definitions in `aws/fargate/stacks/04-services.yaml`.
  Nginx-Fargate intentionally deferred (see F-1.2 below).
- ✅ **Per-org rate limit on `/observability/*`** — `OBSERVABILITY_LIMITER_*`
  env, 30 req/min/org default, keyed off the existing org-aware `rateLimitKey`.
- ✅ **Alerting** — full Alertmanager wire-up (compose + k8s + kustomization
  + NetworkPolicy + startup-script ConfigMaps), 5 initial rules in
  `alert-rules.yml`, severity-based Slack routing, `/dashboard/observability/alerts`
  page with per-org silence create/delete (caller's `org_id` is force-injected
  into the matcher set for non-sysadmins).
- ✅ **Per-plugin drill-down** — `plugin_name` label on the
  `plugin_builds_total` counter (counter-only, durations via Loki for
  cardinality safety), three new catalog entries, plugin-builds dashboard
  switches to per-plugin view when `?plugin=` is set, plus a Loki-backed
  recent-builds `TablePanel`.
- ✅ **Log dashboard details drawer** — `/dashboard/logs` rows are clickable;
  the side drawer at `frontend/src/components/observability/LogDetailsDrawer.tsx`
  shows parsed JSON fields, Loki labels, stack traces, and the raw line with
  per-block copy buttons.

The detailed implementation plans for the above stay in this directory as
historical reference / source-of-truth:
[`alerting.md`](alerting.md), [`per-plugin-drilldown.md`](per-plugin-drilldown.md),
[`k8s-fargate-hardening.md`](k8s-fargate-hardening.md).

---

## P0 — Still-pressing CI hygiene

The frontend `jest@30.3.0` pin closed one incident, but every other
projen-managed subproject still has the same loose caret + lockfile-less
Docker install combination that caused it.

### F-0.1 — Jest pin sweep for non-frontend subprojects (~50 LoC `.projenrc.ts`)
- Frontend done (`jestVersion: '30.3.0'`); replicate in every other
  `*Project()` that has `jest: true`
- Subprojects: `api/quota`, `api/pipeline`, `api/plugin`, `api/billing`,
  `api/compliance`, `api/reporting`, `api/image-registry`,
  `api/message`, `platform`, `packages/api-core`, `packages/api-server`,
  `packages/pipeline-data`, `packages/pipeline-core`,
  `packages/ai-core`, `packages/pipeline-events`.
- `pnpm dlx projen && pnpm install`; commit the lockfile + per-package
  `package.json` deltas.
- **Why first**: same caret-range trap as frontend; will fire the next
  time a service's Docker image rebuilds during a jest 30.4.x window.

### F-0.2 — jsdom-env test-trap sweep (~1 hour audit)
- Pattern: tests authored for the `node` env that stub `globalThis.window`
  / `globalThis.localStorage` and silently no-op under jsdom (the project
  default). `useDarkMode.test.ts` and `favorites.test.ts` both fell into
  this trap; expect 3–5 more.
- Audit grep:
  `grep -rl 'globalThis.*window\|globalThis.*localStorage' frontend/test/`
- Per match: either add `@jest-environment node` at the file's leading
  docblock, or rewrite to use jsdom bindings directly
  (`Object.defineProperty(window, 'localStorage', …)`).

### F-0.3 — Dockerfile lockfile-copy pattern (~100 LoC across Dockerfiles)
- Per-service Dockerfiles copy only `package.json`, so caret-range deps
  resolve to "latest at build time" — every transient dep version drift
  becomes a "why is CI red today" mystery.
- Fix: copy `pnpm-lock.yaml` + `pnpm-workspace.yaml` into the build context
  and run `pnpm install --frozen-lockfile`.
- **Defer** if F-0.1 absorbs the practical version-drift risk; the
  systemic fix is here but the per-dep exact pin is cheaper to ship.

---

## P1 — Security hardening loose ends

Small, single-purpose PRs left over from the May 2026 hardening push.

### F-1.1 — `automountServiceAccountToken: false` on remaining pods (~50 LoC YAML)
- Currently only the plugin pod has it (where user-built Dockerfiles run via
  buildkitd — the highest-risk surface).
- Sweep the rest of the platform pods that don't talk to the k8s API:
  `platform`, `registry`, `billing`, `compliance`, `message`, `reporting`,
  `quota`, `image-registry`, `frontend`, `nginx`. Both minikube + aws/ec2.
- **Why P1 not P0**: defense-in-depth on top of NetworkPolicy + per-pod
  RBAC; no known exploit path today.

### F-1.2 — Nginx-Fargate hardening (depends on F-1.2a)
- The aws/fargate nginx task is the only one still without
  `ReadonlyRootFilesystem: true`. Its Command does
  `apt-get install nginx-module-njs` at runtime, which writes to
  `/var/cache/apt` + `/var/lib/dpkg`.
- **Blocking prerequisite (F-1.2a)**: build + publish a custom
  `ghcr.io/mwashburn160/nginx-njs:1.27` image that bakes njs in, drop
  the runtime apt-install from the Command, swap the `NginxImage` param
  to the custom image, then apply the same `ReadonlyRootFilesystem` +
  `nginxinc/nginx-unprivileged`-style hardening as the k8s nginx pod.
- ~300 LoC: Dockerfile + GitHub Actions release workflow + Fargate
  manifest edit. Standalone PR; can ship on its own cadence.

### F-1.3 — Alertmanager silences PVC promotion (~80 LoC YAML)
- Today's k8s Alertmanager Deployment uses an `emptyDir` for
  `/alertmanager` — silences are lost on pod restart.
- Promote to a `PersistentVolumeClaim` (`alertmanager-data`, 1Gi)
  modeled on `prometheus-data` / `loki-data` in the same manifest.
- **Defer** until operators report that silence loss is actually painful;
  alerts auto-resilence quickly because rules re-fire and the operator
  who created the silence is presumably still on shift.

---

## P2 — Operator value, ships when capacity allows

Now that alerting + per-plugin labels are in place, two follow-ups
unlock real workflow improvements without much code.

### F-2.1 — Per-plugin alerting rules (~100 LoC YAML)
- Alertmanager pipeline is live; `plugin_name` is now a label on
  `plugin_builds_total`. Add a paramaterized rule template:
  `PluginBuildFailureRateHigh{plugin_name="X"}` — fires per-plugin
  rather than only globally.
- Open question on stakeholder side: do we want per-plugin alerts at all,
  or is the per-org rollup good enough? Defer until an operator asks for
  per-plugin paging.

### F-2.2 — PR-D0 cardinality spike (~0 LoC, 1 day operational)
- The per-plugin drill-down shipped with the conservative
  "counter-only, durations via Loki" path. The original plan called for
  validating that against a real Prometheus instance with synthetic data
  at 10× / 100× / 1000× current scale.
- Worth doing before adding `plugin_name` to any histograms (which would
  unlock duration percentiles from Prom directly instead of Loki).
- Ship as a one-day operational test with a doc-only artifact.

### F-2.3 — `build.event` audit emission via the canonical `audit()` helper
- Today the per-plugin Loki recent-builds table is fed by
  `logger.info('Plugin build event', { eventCategory: 'plugin-build', … })`
  in the queue worker. That's load-bearing (promtail label-promotes
  `pluginName`) but lives outside the platform's `audit()` helper /
  `AuditAction` union.
- Long-term: extend `AuditAction` with `plugin.build.*` and emit through
  the same plumbing. Keeps the audit log as the single source of truth
  rather than a parallel "structured info log" channel.
- **Defer** until the next time someone touches `models/audit-event.ts`.

---

## P3 — Demand-gated, defer until signal arrives

### F-3.1 — DB-stored editable dashboards
- [`db-stored-dashboards.md`](db-stored-dashboards.md): 4 PRs, ~2000 LoC,
  ~4–6 weeks
- Plan itself recommends deferring until 2 of 3 demand signals arrive
  (operator requests a missing panel; someone hand-edits the static
  dashboards; per-org customization becomes a customer ask).
- **Today: zero signals**; revisit quarterly.

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
- `deploy/bin/backup.sh` — now `eval`-free; safe to add
  `set -euo pipefail` since the unsafe-arg risk is gone.

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
