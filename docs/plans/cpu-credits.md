---
layout: default
title: Plan — Build-minute chargeback
---

<!--
Copyright 2026 Pipeline Builder Contributors
SPDX-License-Identifier: Apache-2.0
-->

# Plan — Charging for compute an organization triggers

Compute is the one cost a tenant can run up without limit. Every other
expensive dimension is metered — API calls, AI calls, automation calls, plugin
builds by *count* — but nothing charges for how long that work occupies a core.

Status: **PLAN ONLY — nothing here is built.**

Direction: a new per-period quota metered at the **work boundary**, sized per
tier, with a stackable pack for more. Named **`buildMinutes`** rather than
"CPU credits", for the reason in D1.

## Why this is possible at all

**Not from infrastructure metrics.** `container_cpu_usage_seconds_total` is
scraped (with `container_spec_cpu_quota`, the CFS throttle counters and
`machine_cpu_cores`), so CPU seconds exist — labelled by **container and pod**,
which is the wrong axis. Tenant work does not run in per-tenant containers:

- plugin builds run against a **shared buildkitd sidecar** — the code is explicit
  that the "namespace is shared with the buildkitd sidecar, which runs untrusted
  tenant" work, so every org's builds burn CPU in one container;
- API, AI and pipeline requests run in shared service pods serving all tenants;
- pipeline executions largely run in **AWS CodePipeline / CodeBuild**, outside the
  cluster, where cAdvisor never sees them.

No PromQL recovers an organization from a metric whose finest label is a pod
shared by every organization.

**So meter at the work boundary instead** — when a build finishes, charge its
duration to the org that asked for it. Two consequences, both good:

1. **Platform services are excluded by construction.** Billing, frontend,
   platform, quota, message, reporting, the registry, Prometheus, Grafana, Loki,
   Thanos, Postgres, Mongo and Redis never appear, because none of them is
   tenant-triggered work. There is no denylist to maintain and nothing to keep in
   sync — the opposite of filtering infrastructure metrics, where every new
   platform component is a new exclusion somebody must remember.
2. **The signal already exists.** `plugin_build_duration_seconds{org_id}` is
   already observed per org, and `plugin_builds_total{status, org_id}` already
   counts per org. The measurement is not new work; the accounting is.

## What the machinery already gives us

Adding a quota type is **compiler-guided**. `QuotaType` is a union and
`QUOTA_TYPE_LABELS`, `QuotaTierLimits`, `DEFAULT_TIER_LIMITS` and the frontend's
`QUOTA_TYPE_LABEL` are all `Record<QuotaType, …>` — add the member and `tsc`
enumerates every table that must be filled. Nothing silently defaults.

Everything downstream is generic over `VALID_QUOTA_TYPES` and comes along for
free: the 80%/100% threshold notices (inbox + email + webhook, with the existing
opt-out), the usage ledger and its CSV, pooling at the account root, the at-risk
views, the `429` with an `upgradeUrl`, and the add-on/bundle plumbing.

This is the opposite of the storage quota's position (see
[the storage plan](storage-quota.md)): storage is a *stock* that fits the
per-period model badly and needs special handling everywhere. Build minutes are
a per-period **flow**, exactly like every other quota here, so they inherit the
whole apparatus.

## D1 — Call it `buildMinutes`, not `cpuCredits`

**Decision: `buildMinutes`, scoped to plugin builds, for the first release.**

"CPU credits" promises a measurement we cannot make and invites an expectation
the scope violates: **pipeline executions run in AWS and are not metered at all**
— `pipeline_executions_total` does not even carry `org_id`. A quota called
"CPU credits" that ignores the largest compute an org can trigger would charge
the org that builds plugins and let the org running hundreds of pipeline
executions pay nothing. That is not a rounding error; it is a fairness inversion
customers will notice and be right about.

`buildMinutes` is self-documenting: it says what it counts, and nobody
reasonably expects pipeline runs to be in it. Ingesting CodeBuild is then an
honest follow-on (Phase 4) rather than a correction to a promise already made.

## D2 — One minute of one vCPU, charged on wall-clock × allocation

**Decision: a credit is a vCPU-minute;** a build is charged
`ceil(duration_seconds × buildkit_vcpu / 60)`.

Per-build CPU is not observable — buildkit is a shared sidecar — but **slot
occupancy is**, and it is what the platform actually pays for. An org that holds
a build slot for ten minutes costs that slot whether it pegs the core or not, so
occupancy is both the measurable quantity and the fairer basis.

`buildkit_vcpu` comes from the deployment: the minikube tree sets the buildkitd
container to `1500m`, i.e. 1.5 vCPU, so a 10-minute build costs 15
`buildMinutes`. It must be read from configuration rather than hardcoded, since
an operator who raises the limit raises the real cost per minute.

## D3 — Reserve an estimate, then true up

**Decision: reserve a pessimistic estimate at admission; settle the difference on
completion.** This replaces an earlier draft of this plan that said "meter after,
refuse the next one" — that was wrong, and the reason is worth keeping.

Build cost is unknown until the build ends, which argues for charging afterwards.
But a budget checked at admission and charged at completion bounds nothing:
**N builds can all be admitted while the budget allows one.** A Developer org
with 15 credits left can still have twenty builds admitted; at a 10-minute build
(15 credits) that is 300 credits spent against 15 remaining — a 20x overshoot,
not a rounding error. Every other expensive quota here avoids exactly this by
reserving atomically before the work.

So:

- **Admission** — reserve an *estimate* (a configured floor, or the org's recent
  median build cost) through `withQuotaReservation`, the same primitive the
  `plugins` quota already uses on this path. Over budget, refuse with the
  standard `429` + `upgradeUrl` (`sendQuotaReserveDenied`). Concurrent overshoot
  is then bounded by `estimate x concurrency` rather than unbounded.
- **Completion** — true up: charge the remainder if the build ran longer than the
  estimate, refund the difference if it was quicker.
- **A running build is never killed.** Killing to enforce a quota wastes the
  minutes already spent and leaves the org with nothing for them.
- **Settle on the RESERVATION path, never the metered one (Q1).** The metered
  increment path applies *partial admission* — "the counter moves by as much as
  fits and never past the cap; the remainder is recorded as `overshoot`". At one
  unit per API call that is immaterial; a build's true-up is 15–100 units in one
  increment, so a partial fit would record the overrun as overshoot and **never
  charge it**. An org that overran would get the overrun free. Reservations are
  the exact path and stay synchronous for exactly this reason, which is why
  `plugins`, `pipelines` and `aiCalls` all use them.
- **Carry the reservation's `resetAt` into the true-up (Q2).** Builds are the
  longest-running quota'd operation in the system — 20–60 minutes against a
  boundary that arrives every 3 days — so a build straddling a period reset is
  inevitable at volume, not exotic. The refund/settle path already threads
  `reservation.quota.resetAt` to stop a rollover double-charging; the true-up must
  do the same, or it settles against the wrong period.
- **The UI must show the reservation as in-flight** (F3). Reserving then refunding
  makes displayed usage climb and then drop, which no other quota does on a
  human-visible timescale and which reads as a bug. That display is part of this
  decision, not a downstream nicety.

**The two gates must unwind together.** `upload-plugin.ts` already wraps the
upload in a `plugins` reservation, with the discipline spelled out in its own
comment: a throw refunds automatically, and `markConsumed()` at hand-off stops
that refund once the queued job owns the slot. Adding `buildMinutes` makes two
reservations on one submission, so a refusal of either must release the other —
state the order, and unwind both in one place. Two budgets reserved together and
released separately is the defect shape that leaks a slot on every refusal.

## D4 — Charge failed builds

**Decision: a build is charged for the time it ran, whatever its outcome — with
one carve-out.**

`createBuildFailedHandler` is a separate path from `completedHandler`, and a
build that fails after eight minutes consumed eight minutes. If only successes
are charged, the cheapest way to obtain free compute is to fail — so both
handlers meter, and a cancelled build is charged for the time it ran.

**The carve-out is whose fault it was.** A failure caused by tenant content (a
broken Dockerfile, a failing smoke test, a refused scan) is the tenant's compute
and is charged. A retry forced by infrastructure — a worker eviction, a transient
registry error — is the platform's, and charging an org three times for one
submission because the platform retried it twice is indefensible.

**The field for that line already exists:** `FailureCategory` is
`'retryable' | 'permanent'` (`api/plugin/src/helpers/plugin-helpers.ts`), carried
on the job and set by the failure handler. `retryable` is the platform's — do not
charge the re-attempt; `permanent` is the tenant's. The multiplier is real rather
than hypothetical: `PLUGIN_BUILD_MAX_ATTEMPTS` defaults to 2 on the main queue,
so one submission can burn two attempts with no further human action. Phase 2
should name the field, not restate the principle.

The charged-on-failure rule wants saying out loud in the product copy, because it
is the part of this scheme a customer is most likely to find surprising.

## D5 — A per-build ceiling, and no sub-allocation yet

**Decision: cap what one build may cost; do not carve the budget per team.**

Build minutes pool at the account root like every flow quota, so one team's
runaway build loop consumes the **whole account's** compute — and before D7 cut
the period to a day, that meant up to three days in which no team in the account
could build.
`apiCalls` tolerates this because it is cheap and large (25k–1.5M); one spike is
absorbed. Build minutes are few, expensive, and slow to refill, so the same
pooling behaves much worse.

Two mitigations, and only one is worth building now:

- **A per-build ceiling (do this).** Refuse any single build projected beyond N
  credits, and stop a pathological build from consuming a tier's budget on its
  own. Cheap, and it addresses the common case — one broken Dockerfile looping,
  not deliberate abuse.

  **The ceiling must be ≤ the smallest tier's period budget**, or a build that
  hits it can never be admitted on that tier at all. At Developer's 100/day (D7)
  a 60-minute ceiling at 1.5 vCPU is 90 credits, which fits — barely. The old
  three-day window hid this constraint; the daily one makes it binding, so pick N
  against the smallest row of the Phase 1 table rather than in the abstract.
- **Per-team sub-allocation (defer).** Predictable, and the same option the
  storage plan deferred for the same reason: it is an administration surface
  nobody has asked for. Revisit if accounts actually contend.

The residual risk after the ceiling is many legitimate builds from one team
crowding out another. That is the pooled model working as designed, and it is
visible — the at-risk views and the 80% notice name the account, not the team.

## D6 — The admission check fails CLOSED

**Decision: refuse the build when the budget cannot be read.**

Quota checks "time out fast (fail open)" after `QUOTA_CHECK_TIMEOUT_MS` (300 ms),
counted on `quota_fail_open_total`, which alerts. That is right for `apiCalls`:
breaking the console because the quota service blinked is worse than serving a
few unmetered requests.

`storageBytes` is deliberately the exception — a longer read budget behind a
**fail-closed** push gate, on the reasoning that an unverifiable cap must not let
an over-quota org consume. Build minutes sit on that side of the line: expensive,
deferrable by seconds without harm, and the thing being protected is real
compute. A build refused because the budget could not be read is a retry; a build
admitted on an unreadable budget is capacity given away.

Give the check the longer budget storage gets rather than the 300 ms hot-path
one — an admission check runs once per submission, not once per request, so it
can afford to wait for an answer instead of guessing.

## D7 — A daily period for build minutes, not the global three days

**Decision: give `buildMinutes` its own ONE-DAY period. Leave `QUOTA_RESET_DAYS`
alone for every other quota.**

This settles what an earlier draft left open ("accept the three-day window, or
argue for a per-type period"). Three findings decided it.

**The invariant that was supposed to make the window harmless does not hold.**
Phase 1 used to claim `plugins` "stays the primary limit on every tier by
construction: a tier runs out of *builds* before it runs out of *minutes*". That
is false on the failure path, and the failure path is the one that matters.
`releasePluginQuota` (`api/plugin/src/queue/build-quota.ts`) **refunds** the
`plugins` slot on every terminal failure, while D4 charges `buildMinutes` for a
tenant-caused one. So a broken Dockerfile costs minutes and no plugins. On
Developer's old 300, a 15-minute failing build at 1.5 vCPU is ~22 credits, so
roughly thirteen failed iterations exhausted the budget **with the `plugins`
counter still at 0/10** — and then nobody in the account built for up to three
days.

The two quotas cannot be reconciled, either. Charging `plugins` for failures
would give a Developer ten *attempts* per period, which is worse for the exact
workflow Phase 1 already flags as that tier's weak point (someone iterating on a
Dockerfile, no warm cache). Refunding `buildMinutes` is the free-compute hole D4
exists to close. So they diverge permanently, the claim is struck, and window
length becomes the only lever.

**A per-type period costs much less than assumed.** The earlier draft called it
"a change to the quota service, not a config tweak". It is nearer the latter:
`resetDays` is already a **parameter** of both rollover stages
(`resetIfExpiredStage(usagePath, amount, resetDays)` and its pooled twin in
`api/quota/src/services/quota-service.ts`), and `resetAt` is already stored **per
counter**, not per org (`api/quota/src/models/organization.ts`). Rollover is lazy
and evaluated per type inside the Mongo pipeline, so there is no sweep to change
and no schema migration. The real work is one response-contract change:
`periodDays` is a single top-level field on `OrgQuotaResponse` that the
dashboard's "per N days" copy and its usage forecast read, and it has to move
into each `QuotaSummary`.

**Same throughput, a third of the lockout.** A day gives an account exactly the
same minutes over three days as the old window did; it only caps the worst-case
wait at one day. For a resource that is few, expensive and slow to refill, the
shorter wait is worth more than the longer window's burst absorption — which the
per-build ceiling (D5) already provides in the only shape that matters.

Two riders this creates, both small and both real:

- **The two quotas now refill on different clocks** — `plugins` every three days,
  `buildMinutes` daily. The page already renders a per-type `resetAt` (it is on
  every `QuotaSummary`), so this surfaces correctly once `periodDays` is
  per-type; it is a copy problem, not a mechanism one. It also removes the last
  reason to describe the two quotas as a ladder.
- **D5's per-build ceiling must be ≤ the smallest tier's period budget**, or a
  build that hits the ceiling can never be admitted on that tier. At Developer's
  100/day a 60-minute ceiling at 1.5 vCPU is 90 credits, which fits — barely. The
  three-day window hid this constraint; a daily one makes it binding, so it
  belongs in D5 as a check rather than in someone's head.

**Also extend the existing grace band.** `enforcedQuotaLimit`
(`packages/api-core/src/types/quota-tiers.ts`) already implements a soft overrun
above the nominal cap, and it was built for this complaint in these words: "a
self-mutating pipeline that hard-stopped at 100% stayed stopped until the period
reset, up to 3 days." Today it is a hardcoded `quotaType !== 'automationCalls'`.
Generalise it to a per-type grace lookup fed by `QUOTA_AUTOMATION_GRACE_PCT` and
a new `QUOTA_BUILD_MINUTES_GRACE_PCT`, rather than adding a second special case
to the predicate. The band does not solve a lockout — it is 10% — but it removes
the cliff at exactly 100%, which is the half of the complaint it was designed for.

## D8 — One build budget, not a human/automation split

**Decision: do not mirror `automationCalls`. Add a `trigger` label to the build
metric, and revisit only if the data says to.**

The symmetry argument is tempting and was worth writing down: `automationCalls`
exists "so a fleet of pipelines or CI scripts can't lock people out of the
console", and CI-triggered builds could equally lock out a human iterating on a
plugin. But the analogy breaks on *what each split protects*.

**`automationCalls` separates two different surfaces.** Automation spends on
writes; what is being defended is a human's ability to *read the console* — a
different activity, which the split genuinely protects. Build minutes have only
one surface: building. A separate automation budget does not give the human a
build slot (both contend for the same buildkitd regardless), it only gives them a
smaller private budget. That is a sub-allocation, and **D5 already deferred
per-team sub-allocation for precisely this reason**: it is an administration
surface nobody has asked for.

**It is also not the cheap mirror it looks like.** The `apiCalls` /
`automationCalls` choice is made in middleware, where the principal is in hand. A
build's charge lands in a queue handler, and `PluginBuildJobData`
(`api/plugin/src/helpers/plugin-helpers.ts`) carries `orgId`, `userId` and an
`access` snapshot but **no principal type**. The split needs a new payload field
threaded through the upload route, the DLQ replay and the failed-build retry —
paths already carrying delicate snapshot semantics (`reservedResetAt`,
`quotaReleased`).

**And the deciding evidence is one label away.** The earlier draft said the
`org_id`-labelled build metrics "could answer today" how much volume is
automated. They cannot, quite: `plugin_builds_total` carries `{status, org_id}`
only (`api/plugin/src/queue/plugin-build-queue.ts`,
`api/plugin/src/queue/failure-handler.ts`). Adding a bounded
`trigger: 'user' | 'automation'` label is one line in each of those two call
sites and makes the question answerable **before** anyone builds a second budget,
two more tier numbers, a second pack and two more frontend rows. Do that in
Phase 2 and leave the split unbuilt.

If the data ever justifies it, note that the cheaper remedy comes first: a
per-build ceiling (D5) already bounds one runaway automated build, and the grace
band (D7) already removes the hard stop that makes a shared budget feel punitive.

## D9 — Tiers are bounded by SUPPLY, not only by demand

**Decision: no tier's daily budget may exceed what the deployment's buildkitd can
actually deliver, and the ladder below must be checked against that before it is
sold.**

This is the one decision that changes the plan's conclusions rather than its
details, and it was missed because the Phase 1 table is derived from the
`plugins` cap — a DEMAND model — with nothing on the other side of the equation.

**The arithmetic.** A credit is a vCPU-minute (D2). `deploy/*/k8s/plugin.yaml`
gives the buildkitd sidecar `cpu: "1500m"`, one sidecar per plugin pod, with
`replicas: 1`. So the whole platform can deliver

> `1.5 vCPU x 1440 minutes = 2,160 vCPU-minutes per day`

against the demand-derived ladder:

| Tier | Cap/day | Share of the ENTIRE pool |
|---|---|---|
| Developer | 100 | 5% |
| Pro | 300 | 14% |
| Team | 800 | 37% |
| Business | 2,000 | **93%** |
| Enterprise | 4,500 | **208%** |

**One Enterprise tenant's cap is twice the platform's total daily capacity** —
undeliverable with no other tenant on the system at all. One Business tenant
leaves 160 vCPU-minutes a day for everybody else. Two Team tenants take 74%.

**This is not ordinary oversubscription.** Selling more than you have is normal
and healthy where nobody uses their whole cap — that is exactly the reasoning
behind the storage plan's `StorageCommitmentExceedsCapacity`, which fires only
past ~10x. Here the top tier's cap cannot be met *in isolation*, and the failure
mode is different in kind: a full disk stops everyone, while a saturated build
pool QUEUES everyone. The quota as designed caps a VOLUME and says nothing about
concurrency, so two tenants with budget to spare still wait behind one buildkitd.

**Scaling the ladder down does not work, and that is the useful finding.** Hold
Enterprise to half the pool (1,080/day) and the whole table scales by 0.24:
Developer lands at 24 credits/day, which at 20 wall-minutes and 1.5 vCPU is
**0.8 builds a day** — the tier could not finish one build. The ladder and the
shipped capacity are not reconcilable by re-picking numbers.

So SUPPLY is the variable that has to move, and the plan must say by how much:

- Enterprise's 4,500/day needs `4500 / 1440 = 3.125` vCPU of buildkitd running
  flat out, with zero headroom and nothing left for any other tenant.
- Allowing a single tenant at most HALF the pool — a floor worth stating, since
  anything above it means one customer can starve the rest — needs **≥ 6.25
  vCPU**.
- At the shipped 1.5 vCPU the honest top tier is Business-sized (2,000/day) and
  only if it is the sole tenant building.

**What to build, rather than what to assert:**

1. Read the vCPU figure from configuration, which D2 already requires, and
   derive `dailySupply = buildkit_vcpu x 1440` from it.
2. A boot-time check and a test: `max(tier buildMinutes) <= dailySupply x
   SINGLE_TENANT_SHARE`. A deployment whose ladder exceeds its own capacity
   should refuse to sell the tiers it cannot serve, or at minimum say so loudly
   at startup — the same shape as the tier-config echo already in the quota
   service's boot path.
3. The sold-vs-supply gauge and alert, copied from the storage work rather than
   invented: `quota_buildminutes_committed_bytes` over `dailySupply`, warning
   only, not routed to any actuator. Compute cannot be auto-expanded the way a
   PVC can, so there is nothing for an actuator to do.
4. Document the vCPU each tier REQUIRES, so an operator who enables Enterprise
   knows it is a node-sizing decision and not a price-list edit.

**One wrinkle for whoever sizes it.** buildkitd is a sidecar of the plugin pod,
so supply rises either by raising that container's limit (a bigger node — and
rootless buildkit already constrains the node choice: see the Fargate note in
the deploy docs) or by scaling plugin replicas, which multiplies buildkitd
instances. The second breaks D2's "shared sidecar" premise: per-pod capacity
becomes the unit, and a tenant's builds may land on either, so the ceiling is
per-pod while the quota is per-account. Prefer the bigger limit until that is
designed.

## Phase 1 — The quota type

- Add `buildMinutes` to `QuotaType` and `VALID_QUOTA_TYPES`, then fill the tables
  `tsc` names: `QUOTA_TYPE_LABELS` ("Build minute"), `QUOTA_UPGRADE_PATH`,
  `QuotaTierLimits`, `DEFAULT_TIER_LIMITS`, and the frontend's
  `QUOTA_TYPE_LABEL`.
- Add it to `DISPLAYED_QUOTA_TYPES` so it shows on the quotas page from day one.
  (Storage's absence from that list is a live bug; do not create a second one.)
- **Verify the pooling inheritance rather than assume it.** Everything downstream
  is generic over `VALID_QUOTA_TYPES`, but storage is the standing counter-example
  of a quota that looked generic and needed a carve-out in `pooled-quota.ts`.
  Confirm two things before relying on it: that a TEAM-triggered build increments
  the ROOT's counter through `resolveIncrementRoot`, and that the admission check
  reads the pooled limit rather than a team's own `-1`. Getting the second wrong
  reproduces the storage bug exactly — every team spending past the root's cap,
  because the gate reads `-1` as unlimited.
- **Make the period per-type (D7).** `resetDays` is already a parameter of
  `resetIfExpiredStage` and its pooled twin, and `resetAt` is already stored per
  counter, so this is a per-type lookup threaded to those call sites — not a
  schema change and not a sweep. The contract work is moving `periodDays` off
  `OrgQuotaResponse` and into each `QuotaSummary`, which the dashboard's "per N
  days" copy and usage forecast read.
- **Generalise the grace band (D7).** `enforcedQuotaLimit` hardcodes
  `quotaType !== 'automationCalls'`; replace the predicate with a per-type grace
  lookup rather than adding a second special case. Both the conditional
  increments and the status read already route through it, so nothing else moves.
- Document the knobs in `docs/environment-variables.md` — every variable read
  through `envInt`/`envBool`/`envStr` must appear there or `env-documented`
  fails the build. The per-tier override `QUOTA_TIER_<TIER>_BUILD_MINUTES` comes
  free with `tierLimitEnv`; `QUOTA_RESET_DAYS_BUILD_MINUTES` (the per-type
  period), `QUOTA_BUILD_MINUTES_GRACE_PCT` (the band) and the buildkit vCPU
  figure each need their own entry.

**Tier sizing — DERIVED, so the argument is about the principle.** An earlier
draft picked a number per tier and asserted it was "generous relative to the
`plugins` count quota". Checked against the real limits (10 / 25 / 50 / 100 /
150) that was true on four tiers and false on the one that matters: it gave
Developer **8 wall-minutes per permitted build** against 24–67 everywhere else,
so the new quota became the binding constraint on the only tier that cannot pay —
and on the tier where builds are *slowest*, with no warm cache and someone
iterating on a Dockerfile.

So the ladder is derived rather than chosen. The budget is **per day** (D7)
while `plugins` is per three days, so the derivation goes through builds per day:

> `daily credits = (plugins_limit ÷ 3) x per-build wall-minutes x buildkit_vcpu`

| Tier | `plugins` / 3 days | Builds / day | Wall-min per build | `buildMinutes` / day |
|---|---|---|---|---|
| Developer | 10 | 3.3 | 20 | **100** |
| Pro | 25 | 8.3 | 24 | **300** |
| Team | 50 | 16.7 | 32 | **800** |
| Business | 100 | 33.3 | 40 | **2,000** |
| Enterprise | 150 | 50 | 60 | **4,500** |
| Unlimited | — | — | — | `-1` |

Every row is exact at `buildkit_vcpu = 1.5`, and each is a third of the
three-day figure an earlier draft carried — the same throughput on a shorter
clock, which is the whole content of D7.

**This table is a DEMAND model and is not sellable as it stands.** It is derived
from the `plugins` cap with nothing on the supply side, and D9 shows the top two
rows exceed what the shipped buildkitd can deliver — Business takes 93% of the
whole pool and Enterprise 208% of it. Treat the numbers here as the shape of the
ladder and D9's check as the gate on publishing it.

The only judgement left is the wall-minutes column — how long a build on each
tier is allowed to take on average — which is a question somebody can actually
hold an opinion about. It rises with tier because larger customers build larger
images, not because larger customers deserve more slack.

**What this table does NOT give you is a guarantee that `plugins` binds first.**
An earlier draft claimed it did, "by construction". D7 records why that is false:
a terminal build failure refunds the `plugins` slot and still charges the
minutes, so the two quotas diverge on exactly the path a Developer hits most
(iterating on a Dockerfile). Size the table for normal use, and read the
"how we would know it worked" check as a *detector* of mis-sizing rather than as
a proof it cannot happen.

**Developer deserves a sanity pass as a row, not as a cell.** It already carries
10 builds per period and 2 GB of registry storage — about four images at typical
size. So a Developer can build ten times and store four. Adding a third,
differently-shaped cap to the same workflow is worth reviewing against the other
two rather than in isolation.

## Phase 2 — Metering and admission

- **Meter** in `completedHandler` and in `createBuildFailedHandler`, from
  `job.processedOn` / `finishedOn`, both of which are already read there for the
  duration histogram. Best-effort, like every other increment: never fail or slow
  a build because accounting failed.
- **Admit** before enqueue, alongside the existing `plugins` reservation, so an
  org over budget is told at submission rather than discovering it later.
- **Emit** `build_minutes_charged_total{org_id, outcome}` so the charge is
  auditable against the duration histogram already there — if the two disagree,
  the accounting is wrong.
- **Price retries off `failureCategory`.** BullMQ retries each set
  `processedOn` / `finishedOn`, so a job retried three times charges three times
  unless something says otherwise, and `PLUGIN_BUILD_MAX_ATTEMPTS` is 2 by
  default. Charge a `permanent` failure (tenant content); do not charge the
  re-attempt of a `retryable` one (the platform's). The field is already on the
  job — this is a condition at the meter, not a new taxonomy.
- **Label the build metric with its trigger (D8).** Add a bounded
  `trigger: 'user' | 'automation'` to the two `plugin_builds_total` call sites
  (`plugin-build-queue.ts`, `failure-handler.ts`). This is the one line that
  makes "should automated builds have their own budget?" answerable from data
  instead of from argument, and D8 declines to build the split until it is.
- **Exempt system and seed builds.** Sample plugins load under the `system` org
  and setup-load images are built at install; neither should spend a tier budget.
  One condition, but without it a fresh install spends its own first budget on
  its own seed data.
- **Attribute** in the usage ledger with the same dimensions the AI path uses
  (route, principal, plugin), so "why is our build budget gone?" has an answer.
  Without this the quota is enforceable but not explainable.

## Phase 3 — The pack

`b('build_minutes_pack', 'Build Minutes Pack (+150/day)', …, { buildMinutes: 150 },
<price>, PAID, <sort>, { volumeTiers: CAPACITY_VOLUME })`

A pack grant raises the cap **per period**, so the daily period (D7) rescales the
pack along with the tiers — +150/day is the same purchased capacity as the
+500/3-days an earlier draft carried.

Three things to get right, all learned from the existing catalogue:

- **Give it the volume curve.** `plugin_pack`, `api_pack` and `automation_pack`
  all carry `CAPACITY_VOLUME` (10/20/30% at 4/10/25 units). `storage_pack` is the
  one capacity pack without it, at the highest price — an omission, not a
  decision. Do not copy it.
- **PAID tiers only**, like the other throughput packs: a $0 account that can buy
  capacity has no reason to upgrade for capacity.
- **The binding size constraint is the RATIO BOUND, not the tier boundary, and
  +150 sits exactly on it.** `RATE_PACKS` refuses a pack granting more than half
  the cap of any tier that may buy it (`grant > cap / 2`). Against Pro's 300/day
  a +150 pack is **exactly 50%** and passes only because the comparison is
  strict. Note what that couples: the wall-minutes column above is described as
  "the only judgement left", and any downward revision of Pro's 24 minutes drops
  Pro's cap below 300 and breaks that test. **Pack size and Pro's tier row move
  together.** The no-crossing rule is comfortable by contrast (Pro 300 + 150 =
  450, well under Team's 800).

  An earlier draft justified +150 with "100 + 150 = 250, under 300" — a
  DEVELOPER boundary, which does not apply once the pack is PAID-only, and
  PAID-only is not optional: a separate test asserts `storage_pack` is the only
  capacity pack sold on Developer.
- **Cap the stack.** `stackable` defaults to true and no `maxQuantity` is set,
  so an account could buy arbitrarily many minutes against a pool that delivers
  2,160 a day (D9). D5 added a per-BUILD ceiling for exactly this reasoning;
  this is its pricing-side twin, and without it the catalogue can sell capacity
  the platform has no way to produce.
- **`bundle-sizing` imposes NO price floor on this pack, and an earlier draft
  claimed otherwise.** `buildMinutes` still has to be added to both `DIMS` and
  `RATE_PACKS` — neither is derived from `VALID_QUOTA_TYPES` — but read what the
  test does with it: `closeGap` runs per dimension and the costs are SUMMED into
  one basket, compared once against the tier delta. Adding a dimension therefore
  makes `basket > delta` *easier*, and since the suite passes today without
  `buildMinutes` the property cannot be broken at any price.

  The "~$11.11 floor" (and the ~$13.34 before the daily rescale) came from
  treating the buildMinutes row as if it alone had to exceed the $40 Pro→Team
  delta. It does not, so the worry that $11.99 clears the floor by only 7% was
  about a constraint that does not exist. **The price is a margin decision, not
  a test-satisfying one** — which matters more here than elsewhere, because this
  is the one dimension the platform pays for per unit.
- **Register the Marketplace dimension.** `DEFAULT_BUNDLE_DIMENSION_MAP` must
  gain `build_minutes_pack`, and a test holds the catalogue and the map in sync.
  The map's own comment records why: `stakeholder_reports` shipped missing from
  it and was therefore "granted to the customer and then NEVER metered on
  Marketplace, i.e. given away". Of every bundle to give away by omission, the
  only one with real marginal cost is the worst.
- **Decide about `throughput_bundle`.** It is `plugin_pack + api_pack + ai_pack`
  at $25.99 against a $35.97 member basket. Build minutes are *the*
  build-throughput dimension, so either they join it — repricing the combo, with
  `warnOnNonDiscountCombos` requiring it stay below the new basket — or the plan
  says why the throughput combo omits the throughput that costs money.
- **Say something about the annual price.** `b()` defaults `annual` to
  `monthly x 10`: two months free, ~17% off, the steepest standing discount in
  the catalogue. Inheriting it on the only dimension with per-unit cost should be
  a decision rather than a default.

**GRANT GRANULARITY IS THE DECISION BEHIND MOST OF THE ABOVE, and +150 is
probably the wrong end of it.**

Every add-on is quantity x a fixed grant; the grant size is simply the step the
buyer types. `seat` grants 1, so typing 8 means 8 seats. `storage_pack` grants
10 GB and is typed IN GB, because `AddonGrid` divides the grant by
`quotaPackUnit(dimension).per` — which means build minutes are typed in minutes
for free, but only if the catalog entry declares
`packUnit: { name: 'min/day', per: 1 }`. F2 below promises a LABEL ("2h 30m of
build time a day") and not the typed unit; it needs both.

A finer grant is better on the constraint that actually binds and worse on one
the plan got backwards:

- **It removes the ratio-bound coupling.** At +25/day the pack is 8% of Pro's
  cap instead of exactly 50%, so Pro's wall-minutes column can be retuned
  without breaking a test.
- **It makes `CAPACITY_VOLUME` wrong.** Those breaks (10/20/30% at 4/10/25
  units) are sized for a COARSE pack. At +25/day a Pro buyer topping up 300
  minutes buys 12 units and lands in the 20% band; at +1/day everyone clears 25
  units and takes **30% off permanently** — on the one dimension with real
  marginal cost. The catalogue already encodes the rule the plan missed:
  `seat` is the granular pack and therefore carries its OWN, much higher breaks
  (5/15/40). Granularity moves the breakpoints; copy `seat`'s shape, not
  `storage_pack`'s.
- **It makes `maxQuantity` the only control.** Which is fine, and D9 says what
  to derive it from.

Recommendation: a **+25/day grant with seat-style volume breaks, an explicit
`maxQuantity` from pool capacity, and a `packUnit` so it is typed in minutes.**
"Enter 120" then means 120 more minutes a day, which is the number a buyer
actually has in mind — the same reasoning that made storage typed in GB.

## Phase 3b — Every existing capacity pack now under-grants

Adding a dimension that is DERIVED from another one silently breaks the packs
that grant the other one. The formula is
`credits/day = (plugins / 3) x wall-minutes x vcpu`, so:

| Pack | Grants | Build minutes it needs | Grants today |
|---|---|---|---|
| `plugin_pack` | +10 plugin builds / period | ~**150**/day | 0 |
| `pipeline_pack` | +5 pipelines, +25 plugins (Team) | ~**400**/day | 0 |

A buyer of either gets builds they have no minutes to run. **This repository has
already made this exact mistake twice and fixed it twice**, and both comments are
still in the catalogue:

- `pipeline_pack` grants plugins alongside pipelines because "a pipelines-only
  pack broke that ratio for anyone who bought it … so the pipelines it sold could
  not be built for";
- `seat` grants API and AI capacity because "a seats-only pack broke that
  invariant for anyone who bought it … and nothing told the buyer. Granting the
  per-seat share keeps a bought seat worth what a tier seat is worth."

So extend both grants, and add the invariant test beside the one that already
holds "every tier keeps 5 plugin builds per pipeline, packs included" — a
minutes-per-plugin-build ratio is the same guard on the same relationship.

**One conflict to resolve first:** `RATE_PACKS` requires a pack to grant exactly
ONE dimension (so `BILLING_BUNDLE_<ID>_GRANT` keeps working), which is why
`pipeline_pack` is classed as a differentiator and exempt. A `plugin_pack` that
also granted minutes would have to leave `RATE_PACKS` the same way — losing the
ratio bound and the free-tier guard with it. Either accept that trade, or decide
deliberately that plugin builds and their minutes are sold separately and say so
where a buyer can read it.

## Phase 3c — Capped, not metered. A decision, not an omission

Build minutes are the **first quota with genuine per-unit marginal cost**. Every
other dimension is a rate limit protecting shared infrastructure; this one is
compute the platform actually pays for. That invites a pricing model the plan
never weighs: meter it and bill overage, rather than cap it and sell packs.

Capped is still right, for a reason worth writing down rather than assuming:
there is **no overage-billing machinery in this codebase at all** (the storage
plan recorded the same thing — "there is no overage billing"). A cap plus packs
reuses the whole bundle apparatus; metering is a new subsystem with its own
invoicing, disputes and proration. Revisit only if build minutes become a
material share of revenue.

## Phase 4 — Ingest CodeBuild, and rename

The honest completion of D1. AWS reports duration and compute type per build, and
`pipeline-manager` already talks to AWS, so the data is reachable. Once pipeline
execution compute is metered:

1. add `org_id` to `pipeline_executions_total` — one label, and executions become
   attributable by count even before any of this;
2. charge CodeBuild duration × its compute class into the same quota;
3. **then** the name `cpuCredits` becomes accurate, and the rename is a migration
   with a reason rather than a promise made early.

Until then the quota is honestly scoped and honestly named.

## Both open questions are now decided

The two questions this plan used to leave open — the three-day period (Q3) and a
separate budget for automated builds (Q5) — are settled in **D7** and **D8**.
Each was resolved by checking the code rather than by picking a side: Q3 turned on
finding that the invariant meant to make it harmless is false and that a per-type
period is far cheaper than assumed; Q5 turned on finding that the surface being
protected is not analogous and that the payload carries no principal to split on.

The remaining judgement is the wall-minutes column of the Phase 1 table, which is
flagged there and is a product opinion rather than a question about the code.

## Checked and NOT a gap: the seat pack

`seat` carries a per-seat capacity invariant — every paid tier holds exactly
100,000 API calls and 200 AI calls per seat, and the pack grants that share so a
bought seat is worth a tier seat. The obvious question is whether it must now
grant build minutes too.

It must not, because there is no invariant to preserve: per-seat minutes are
**not** constant across the ladder — Pro 300, Team 267, Business 250,
Enterprise 300. Recorded so nobody re-raises it.

Worth noticing while here, though: **Pro and Enterprise already sit at exactly
300 per seat.** Re-deriving Team to 900 and Business to 2,400 would make the
whole column constant, let `seat` carry build minutes like it carries the other
two, and bring the dimension under the existing invariant test for free. That is
an improvement rather than a defect — and it collides head-on with D9, since
2,400/day is above what the shipped pool can deliver at all. Decide the supply
question first; this one is downstream of it.

## Out of scope, and bounded: quarantine builds

Anonymous submissions build on a **separate quarantine buildkitd** (`1000m`),
and their jobs carry "nothing but a submission id" — no `orgId` — so that compute
falls on the platform rather than a tenant. It is deliberately not charged, and
it is not a hole: the isolated pool is small by design and runs **one build at a
time**, which bounds it without a quota.

Recorded for the same reason the storage plan records that quarantine *storage*
is bounded by an unconditional 30-day sweep — so the next reader does not have to
re-derive the answer.

## Docs and frontend

Enforced contracts, not polish — the same list the storage plan carries:

| Item | Contract |
|---|---|
| New env vars | `docs/environment-variables.md`, or `env-documented.test.ts` fails |
| Any doc edit | the help corpus is SHA-pinned to its source doc; regenerate or `help-corpus.test.ts` fails |
| Quota type | the `Record<QuotaType, …>` tables are compiler-forced; the frontend label map is one of them |

### Frontend

An earlier draft called this work "free" twice and was wrong twice. Two of the
five deliverables have since **become** nearly free, for a reason worth
recording: the quota display catalog
(`packages/api-core/src/types/quota-catalog.ts`) was built after that draft and
collapsed the seven label/unit maps the frontend used to carry. F1 and F2 are now
catalog entries rather than new mechanisms; F3–F5 are the real work.

**F1 — a `minutes` render mode (now one entry, compiler-enforced).** The draft
said `QuotaCard` formats everything through `fmtNum` and that build minutes would
be the second quota needing unit-aware display. That display is built:
`QuotaRender` is `'count' | 'bytes'`, `formatQuotaValue` switches on it
**exhaustively**, and `QuotaCard`, `UsageCard`, `TeamUsageCard` and both at-risk
lists all route through it. So adding `'minutes'` to the union makes `tsc` name
every surface that must handle it — the case the exhaustive switch was written
for. The work is the mode plus its formatter ("2h 30m"), not a new pathway.

**F2 — a `packUnit` on the catalog entry.** The draft described `PACK_UNITS` as a
hardcoded map with one member (`storageBytes` → GB), and framed adding build
minutes as a judgement its comment had already set up. That map is gone; the unit
is `packUnit` on the catalog entry and `AddonGrid` reads it through
`quotaPackUnit`. The judgement still stands and still falls the same way — a
+150/day pack reading "2h 30m of build time a day" says far more than "1 pack" —
but it is now a field, not a map to extend.

**F3 — show in-flight reservations, or the number appears to go backwards.**
D3 reserves an estimate at admission and settles on completion, so while a build
runs, `used` includes a reservation that may be **refunded** if the build beats
the estimate. The page will show usage climb and then drop. No quota does that
today — AI reservations settle in seconds, builds in minutes — so there is no
existing affordance for it, and without one it reads as a bug and generates
support traffic about wrong numbers. Either show "N in flight" explicitly or
render the reserved portion distinctly from the settled portion. **This is a
requirement on D3, not a frontend nicety:** a quota that trues up on a
human-visible timescale has to say so.

**Post-purchase latency is bounded, and worth saying (Q6).** A *denied* check
reading is cached until the period resets, capped at
`QUOTA_CHECK_DENIED_CACHE_MS` (60 s), explicitly "so an upgrade, a bundle or an
operator reset is honoured within a minute". So an org that buys a pack to
unblock a build may wait up to a minute. That is deliberate and bounded, not a
defect — but the purchase confirmation should say so, or it will be reported as
one.

**F4 — two refusals, two messages.** D5 adds a per-build ceiling, so there are
now two distinct rejections: *budget exhausted* (buy a pack, or wait for reset)
and *this single build is too expensive* (fix the build — a pack will not help).
One shared 429 message sends people to buy capacity that cannot solve their
problem.

**F5 — a cost hint before the build, modelled on `AIQuotaHint`.** The closest
precedent in the codebase, built for exactly this: "the one line every AI surface
shows BEFORE a generation: how many AI calls are left and when they reset, said
up front instead of discovered as a 429". It already handles the not-charged
case, disables the action on the same predicate the caller uses, and fails open
when the quota cannot be read.

A build submission deserves it more than an AI call does: one build is ~15
credits against a Developer budget of 100/day (D7) — **15% of the period in a
single action**, where one AI call is a fraction of a percent. The daily period
sharpens this rather than softening it: the same build is a larger share of a
smaller window, so discovering the cost as a 429 is correspondingly worse. The
line should read "this build will cost about 15 of your 85 remaining minutes
today" *before* the upload. **Highest-value frontend item here**, and the one an earlier draft of
this plan omitted entirely while calling the frontend work free.

### Docs

A build-minutes section in `docs/quotas.md`: the unit and how it is derived, the
per-tier table, that **failed builds are charged** (and which retries are not),
the per-build ceiling, and what the pack buys.

## How we would know it worked

- **Does the charge match reality?** `build_minutes_charged_total` summed per org
  should track `plugin_build_duration_seconds{org_id}` × the vCPU figure. Drift
  means the accounting is wrong, and this is the check that catches it.
- **Does it bind before the count quota?** If `buildMinutes` refusals outnumber
  `plugins` refusals on any tier, that tier's per-build allowance in the derived
  table is too low — this quota is meant to catch pathological duration, not
  normal use. Watch Developer first: it is the tier where the two are closest.
- **Does anyone buy the pack?** If orgs hit the cap and churn rather than buying,
  either the cap is too low or the pack is priced wrong.

## Rough sizing

| Phase | Size | Why |
|---|---|---|
| 1 | Small–Medium | A union member plus compiler-named tables; D7 adds a per-type period (a lookup threaded to two call sites) and moves `periodDays` into `QuotaSummary`, which touches the dashboard |
| Frontend | Medium | F1/F2 are now catalog entries (the display catalog landed); the work is in-flight reservations, two refusal messages, and the pre-build cost hint |
| 2 | Medium | Two metering hooks, a reserve-and-true-up settle shared with the `plugins` gate, retry pricing, exemptions, ledger attribution |
| 3 | Small–Medium | One catalogue entry, two test-list additions, a Marketplace dimension, a `maxQuantity`, and the grant-granularity decision (which also sets the volume breaks) |
| 3b | Small | Extending `plugin_pack` / `pipeline_pack` grants, plus the ratio invariant test — but it needs the `RATE_PACKS` single-dimension conflict resolved first |
| 4 | **Largest** | A new AWS ingestion path, plus a rename migration |

## What this plan deliberately does not do

- **It does not meter from container CPU metrics.** They cannot attribute shared
  pods, and metering at the work boundary excludes platform services by
  construction rather than by a list.
- **It does not kill running builds.** A build that overruns its estimate
  completes and is trued up; the next admission is refused. Killing wastes the
  minutes already spent.
- **It does not charge for API, AI or automation requests' CPU.** Those are
  already metered by count, and double-charging the same work in two currencies
  would make neither explainable.
- **It does not carve the budget per team (D5).** The account pools it, as every
  flow quota does; a per-build ceiling stops the pathological case without a new
  allocation surface.
- **It does not claim to measure CPU.** It measures build-slot occupancy, which
  is what the platform pays for and what can honestly be counted.
- **It does not meter or bill overage (Phase 3c).** A cap plus packs, because no
  overage-billing machinery exists to reuse.
- **It does not model CONCURRENCY (D9).** The quota caps a daily volume; the
  scarce resource is build slots. Two tenants with budget to spare still queue
  behind one buildkitd, and nothing here sells or promises a wait time.
- **It does not split human from automated builds (D8).** One budget, plus a
  `trigger` label on the build metric so the question can be answered from data
  if anyone asks it again.
- **It does not change `QUOTA_RESET_DAYS` for any other quota (D7).** The daily
  period is `buildMinutes`-only; every other counter keeps the global window.

## Sequencing

**D9 FIRST, before anything is published.** It is the only item that can
invalidate the tier table rather than refine it: at the shipped 1.5 vCPU the top
two rows are undeliverable, and no amount of Phase 1–3 work makes a cap the
hardware cannot serve into a real product. Sizing the pool, or trimming the
ladder to it, is the gate on the rest.

Then **1 → 2 → 3 (with 3b)**, then **4** when pipeline compute matters enough.

Phase 1 alone is inert — a quota with no meter. Phase 2 makes it real. Phase 3
without Phase 2 would sell capacity against a limit nothing enforces, which is
worse than not selling it.

Phase 4 is independent of 1–3 in mechanism but dependent in meaning: it is what
turns an honestly-scoped build quota into a complete compute quota. Its first
step (an `org_id` label on `pipeline_executions_total`) is worth landing early
regardless, because it is one label and it makes the gap measurable.
