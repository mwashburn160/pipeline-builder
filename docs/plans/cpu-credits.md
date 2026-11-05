---
layout: default
title: Plan — CPU-credit chargeback
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
tier, with a stackable pack for more. Named **`cpuCredits`**, with what it
covers stated in the product copy rather than encoded in the name — D1 records
why that reverses an earlier draft.

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
per-period model badly and needs special handling everywhere. CPU credits are
a per-period **flow**, exactly like every other quota here, so they inherit the
whole apparatus.

## D1 — Call it `cpuCredits`, and state the scope in the copy

**Decision: `cpuCredits`, surfaced as "CPU credits", with what it covers written
wherever the number appears.**

This REVERSES an earlier draft, which chose `buildMinutes` and deferred
`cpuCredits` until Phase 4 had ingested CodeBuild. That draft's objection was
real and is worth keeping, because it is what the copy now has to answer:

> "CPU credits" promises a measurement we cannot make and invites an expectation
> the scope violates: **pipeline executions run in AWS and are not metered at
> all** — `pipeline_executions_total` does not even carry `org_id`. A quota
> called "CPU credits" that ignores the largest compute an org can trigger would
> charge the org that builds plugins and let the org running hundreds of pipeline
> executions pay nothing. That is not a rounding error; it is a fairness
> inversion customers will notice and be right about.

What changed is the realisation that **the inversion exists under either name**.
`buildMinutes` does not fix the gap; it only declines to mention it. So the
choice is not between an honest name and a dishonest one — it is between an
unstated scope and a stated one, and a stated one is better:

> "CPU credits — the compute your plugin builds occupy. Pipeline executions run
> in AWS and are not counted yet."

One sentence, on the quota card, in `docs/quotas.md`, in the 429 body and in the
threshold notices. At Phase 4 that **sentence** changes, not the name — and
since Phase 4 resizes every tier anyway, the resize is the moment the change is
communicated either way.

Five things make the earlier draft's deferral the more expensive option:

1. **It avoids a post-launch migration.** A quota type is not a label: renaming
   it later moves the catalog key, the `QuotaType` union member,
   `QUOTA_TIER_<TIER>_*`, the pack id, the API field and every doc — in a
   codebase that rejects compat shims, so it is a hard cutover. Choosing the
   final name while nothing is shipped costs nothing.
2. **The plan already speaks in credits — and so does the market.** It says
   "credit" far more often than "build minute", and D2's decision sentence is
   literally "a credit is a vCPU-minute", so naming the dimension in MINUTES
   while its unit is a CREDIT was the actual incoherence. **CircleCI settles it
   independently**: it bills CI compute in *credits* consumed per minute per
   resource class — the same formula D2 arrives at — so "credits" is the
   vocabulary customers coming from the nearest competitor already have.
3. **It fixes the unit problem for free.** A build minute is a vCPU-minute, so a
   10-minute build at 1.5 vCPU costs 15 of them — and "11,250 build minutes"
   reads as 187 hours when it buys 125. An abstract unit cannot be misread
   as wall-clock, so the name no longer depends on F5's cost hint to be
   understood. F5 stays the highest-value frontend item on its own merits
   instead of being a prerequisite of the naming.
4. **It leaves the shipped vocabulary alone.** `plugins` keeps its "Plugin
   build" label. An earlier revision proposed relabelling it "Plugin creation"
   to clear the "build" collision — correct in isolation, but it edits a label
   customers already read on bills, dashboards and 429 bodies in order to
   accommodate a dimension that does not exist yet. "Plugin builds" beside "CPU
   credits" shares no word, so there is nothing left to clear.
5. **It is specifically better than the near-misses.** "Build credits" would
   still collide with "Plugin build"; "Compute credits" dodges AWS's own term but
   promises MORE breadth than "CPU", which is the opposite of what the scope
   objection wants.

**One watch item.** AWS uses "CPU credits" for T-instance burst accrual — a
different mechanism (accrue while idle, spend while bursting). An AWS-literate
customer may map the term onto that one. The scope sentence is what
disambiguates it; if it proves confusing in practice, the fallback is "Compute
credits" and the cost is one more label change, not a migration.

## D2 — A credit is a vCPU-minute, charged in vCPU-seconds

**Decision: a credit is a vCPU-minute, ACCUMULATED IN vCPU-SECONDS;** a build
adds `duration_seconds × buildkit_vcpu` to a seconds counter, and the cap is
compared in the same unit. Minutes are a presentation choice, never the charging
granularity.

Per-build CPU is not observable — buildkit is a shared sidecar — but **slot
occupancy is**, and it is what the platform actually pays for. An org that holds
a build slot for ten minutes costs that slot whether it pegs the core or not, so
occupancy is both the measurable quantity and the fairer basis.

`buildkit_vcpu` comes from the deployment: the minikube tree sets the buildkitd
container to `1500m`, i.e. 1.5 vCPU, so a 10-minute build costs 15
`cpuCredits`. It must be read from configuration rather than hardcoded, since
an operator who raises the limit raises the real cost per minute.

**Why seconds, which an earlier draft got wrong by rounding up to the minute.**
`ceil(seconds x vcpu / 60)` charges a 10-second cached rebuild at 1.5 vCPU a
FULL credit instead of 0.25 — a 4x overcharge — and a 61-second build two. That
is not a rounding nitpick, because of what duration-charging gives away for
free:

**This model already contains the equivalent of Claude's prompt-caching
discount, and minute-rounding throws it away.** Anthropic had to add caching as
a priced feature to discount repeated input (up to ~90% off); charging by
DURATION gets the same effect automatically — a build that hits the layer cache
is short, so it costs less, with no mechanism required. Rounding up to the
minute cancels exactly that discount, on exactly the builds a good cache
produces, so it penalises the behaviour the platform wants to encourage. AWS
moved EC2 to per-second billing in 2017 for the same reason.

Accumulating in seconds costs nothing — it is the same multiplication against a
larger integer — and it is what makes the implicit cache discount real.

**Claim this as an ADVANTAGE, not as a defect being fixed.** Minute-rounding is
the CI norm, not an anomaly: GitHub Actions rounds every job up to the nearest
minute. So charging in seconds does not bring this product into line with the
market — it puts it ahead of the market on exactly the short, cache-hit builds a
well-tuned pipeline produces. An earlier draft of this paragraph cited AWS's
2017 move to per-second billing as though the old behaviour were out of step
with the industry; the direct competitors say otherwise, and the honest framing
is the better one anyway.

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
that refund once the queued job owns the slot. Adding `cpuCredits` makes two
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

CPU credits pool at the account root like every flow quota, so one team's
runaway build loop consumes the **whole account's** compute — and before D7 cut
the period to a day, that meant up to three days in which no team in the account
could build.
`apiCalls` tolerates this because it is cheap and large (25k–1.5M); one spike is
absorbed. CPU credits are few, expensive, and slow to refill, so the same
pooling behaves much worse.

Two mitigations, and only one is worth building now:

- **A per-build ceiling (do this).** Refuse any single build projected beyond N
  credits, and stop a pathological build from consuming a tier's budget on its
  own. Cheap, and it addresses the common case — one broken Dockerfile looping,
  not deliberate abuse.

  **The ceiling must be ≤ the smallest tier's period budget**, or a build that
  hits it can never be admitted on that tier at all. At Developer's 4,500/month
  (D7) a 60-minute ceiling at 1.5 vCPU is 90 credits, which fits comfortably —
  but the margin is a property of the WINDOW, not of the ceiling: on the one-day
  window an earlier draft chose, the same ceiling was 90 against 100 and the
  constraint was nearly binding. Pick N against the smallest row of the Phase 1
  table, and re-check it if the window ever shortens.
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
an over-quota org consume. CPU credits sit on that side of the line: expensive,
deferrable by seconds without harm, and the thing being protected is real
compute. A build refused because the budget could not be read is a retry; a build
admitted on an unreadable budget is capacity given away.

Give the check the longer budget storage gets rather than the 300 ms hot-path
one — an admission check runs once per submission, not once per request, so it
can afford to wait for an answer instead of guessing.

## D7 — A period of its own, and a MONTH

**Decision: give `cpuCredits` its own period and make it a calendar month,
aligned to the subscription. Leave `QUOTA_RESET_DAYS` alone for every other
quota.**

This settles what an earlier draft left open ("accept the three-day window, or
argue for a per-type period"). Three findings decided that it needs its OWN
period; D10 decides the LENGTH, and a one-day window — which two earlier drafts
of this decision chose — is the wrong answer for a reason neither of them
weighed. The reasoning is kept below rather than deleted, because the two
structural findings are what make a per-type period possible at all and they are
unchanged.

**The invariant that was supposed to make the window harmless does not hold.**
Phase 1 used to claim `plugins` "stays the primary limit on every tier by
construction: a tier runs out of *builds* before it runs out of *minutes*". That
is false on the failure path, and the failure path is the one that matters.
`releasePluginQuota` (`api/plugin/src/queue/build-quota.ts`) **refunds** the
`plugins` slot on every terminal failure, while D4 charges `cpuCredits` for a
tenant-caused one. So a broken Dockerfile costs minutes and no plugins. On
Developer's old 300, a 15-minute failing build at 1.5 vCPU is ~22 credits, so
roughly thirteen failed iterations exhausted the budget **with the `plugins`
counter still at 0/10** — and then nobody in the account built for up to three
days.

The two quotas cannot be reconciled, either. Charging `plugins` for failures
would give a Developer ten *attempts* per period, which is worse for the exact
workflow Phase 1 already flags as that tier's weak point (someone iterating on a
Dockerfile, no warm cache). Refunding `cpuCredits` is the free-compute hole D4
exists to close. So they diverge permanently, the claim is struck, and window
length becomes the only lever.

**"Aligned to the subscription" is not implementable as worded, and that is a
real constraint rather than a quibble.** `nextQuotaResetDate` does DAY
arithmetic (`date.setDate(date.getDate() + days)`), and the Mongo rollover adds
`unit: 'day'`. Worse, the reset is LAZY — it fires on the first increment after
expiry — so the boundary follows the org's own activity rather than a calendar.
At three days nobody notices; over a month two things become visible and
arguable:

- a 30-day window **drifts** against the calendar by ~5 days a year, so the
  "quota month" and the billing month come apart; and
- an org that does not build for 40 days resets on its next build, so its window
  start wanders further still.

Two honest options. Either accept a **30-day rolling window** and say so in the
docs and the UI copy — in which case drop "aligned to the subscription", because
it will not be — or switch the reset to month arithmetic (`$dateAdd` does
support `unit: 'month'`) and make `periodDays` carry a unit rather than a day
count. The second is the better product and the larger change: it is a contract
change on the field the dashboard reads, not just a different number in it.
Decide before Phase 1 ships, because the field shape is what Phase 1 moves into
`QuotaSummary`.

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

**Why a MONTH and not a day, which is where the earlier drafts went wrong.**
Shortening the window was argued as "same throughput, a third of the lockout":
a day gives the same minutes over three days and caps the worst-case wait at one
day. That is true and it is not the whole trade. A window does two jobs — it
bounds the burn AND it decides how much of your allowance you may spend at once —
and the earlier reasoning only priced the first.

Build work is **bursty by nature**, and this plan says so elsewhere without
drawing the conclusion: changing a base image rebuilds everything that sits on
it, while publishing another version costs little. So the expensive day is a
base-image bump, a CVE sweep or a release — a day on which an organization wants
its whole catalogue rebuilt at once.

Price that against a daily window at Pro: a full catalogue rebuild is 25 builds
x 30 wall-minutes x 1.5 = **1,125 credits, which is exactly a 1,125/day cap**. The
account spends an entire day's budget on one rebuild and is refused for anything
else it wants to build that day *while holding 10,125 unspent credits for the
month*. A daily window does not ration that work, it
forbids it — and the remedy it leaves (buy a pack) charges a customer for
capacity it has already paid for and cannot reach.

A monthly window is the same total capacity with the accumulation restored, and
D10 is the requirement that settles it: the budget has to cover a month of
normal activity, which it cannot do if a normal month's shape is refused.

**What a month costs, and the mitigations that make it affordable.** The honest
objection is the one D7 was built on: a long window means a long lockout. Four
things bound it, and the last is new:

- **The 80% notice** already fires for a metered flow from its increment path.
- **D5's per-build ceiling** bounds any single build.
- **The pack** takes effect within a minute (a denied check is cached for at
  most `QUOTA_CHECK_DENIED_CACHE_MS`).
- **The usage forecast becomes the main safety mechanism, and a daily window is
  what made it useless.** `QuotaCard` already renders `UsageForecast`, which
  extrapolates the burn rate to the period boundary. On a one-day window that is
  noise; on a month it is the sentence that matters — "at this rate you run out
  on the 22nd" — and it arrives with weeks to act rather than hours.

  **But it has no minimum-elapsed guard, which matters now that it is
  load-bearing.** It projects `used x (total / elapsed)`, so on day one of a
  month a single base-image rebuild extrapolates to thirty of them and the card
  predicts exhaustion that will not happen. The failure is backwards from what
  you want: the forecast is least reliable when there is most time to act, and
  most reliable when there is least. It needs a floor on elapsed time (or a
  confidence band) before anything leans on it — which, on a monthly window,
  everything does.

Two riders this creates, both small and both real:

- **The two quotas now refill on different clocks** — `plugins` every three days,
  `cpuCredits` monthly. The page already renders a per-type `resetAt` (it is on
  every `QuotaSummary`), so this surfaces correctly once `periodDays` is
  per-type; it is a copy problem, not a mechanism one. It also removes the last
  reason to describe the two quotas as a ladder.
- **D5's per-build ceiling must be ≤ the smallest tier's period budget**, which a
  monthly window makes comfortable rather than tight: a 60-minute ceiling at
  1.5 vCPU is 90 credits against Developer's 4,500/month. The constraint stays
  written down in D5 because it is the window length that made it safe, and a
  future shortening would make it binding again.

**Also extend the existing grace band.** `enforcedQuotaLimit`
(`packages/api-core/src/types/quota-tiers.ts`) already implements a soft overrun
above the nominal cap, and it was built for this complaint in these words: "a
self-mutating pipeline that hard-stopped at 100% stayed stopped until the period
reset, up to 3 days." Today it is a hardcoded `quotaType !== 'automationCalls'`.
Generalise it to a per-type grace lookup fed by `QUOTA_AUTOMATION_GRACE_PCT` and
a new `QUOTA_CPU_CREDITS_GRACE_PCT`, rather than adding a second special case
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
different activity, which the split genuinely protects. CPU credits have only
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

**Decision: no tier's budget may exceed what the deployment's buildkitd can
actually deliver over the same period, and the ladder below must be checked
against that before it is sold.**

This is the one decision that changes the plan's conclusions rather than its
details, and it was missed because the Phase 1 table is derived from the
`plugins` cap — a DEMAND model — with nothing on the other side of the equation.

**The arithmetic, and there are TWO numbers — a floor and a ceiling.** A credit
is a vCPU-minute (D2). `deploy/*/k8s/plugin.yaml` gives the buildkitd sidecar
`limits.cpu: 1500m` but `requests.cpu: 300m`, one sidecar per plugin pod, with
`replicas: 1`. Kubernetes schedules on REQUESTS, so:

> **Ceiling** (the limit, available only when the node is otherwise idle):
> `1.5 vCPU x 1440 min x 30 days = 64,800 vCPU-minutes per month`
>
> **Floor** (the request, which is what is actually reserved):
> `0.3 vCPU x 1440 min x 30 days = 12,960 vCPU-minutes per month`

The ceiling is the number a first draft of this decision used, and it is the
optimistic one: a build can burst to 1.5 vCPU only if nothing else on the node
wants the cores. The guaranteed figure is the floor, and against it even **Team
(22,500) is already 174%** — not just the top two rows. Quote both, because
selling against the ceiling is selling capacity the scheduler never reserved.

**The first fix is therefore to raise `requests`, not to argue about the limit.**
A quota that promises 1.5 vCPU of throughput against a 0.3 vCPU reservation is
promising what the scheduler has not set aside; making requests match the
capacity being sold is what turns the ceiling into the floor.

**And that first fix is nearly free, which the $150–180/month figure obscures.**
Raising `requests.cpu` from `300m` to `1500m` buys no hardware: the node is
already paid for, and the reservation only claims capacity that already exists.
It costs money only if co-tenant workloads then need somewhere else to go. What
costs money is capacity BEYOND one replica — and with D12's flattened ladder the
top tier needs 1.56 vCPU reserved, which is one `c7g.large` at about $59/month
(2 vCPU, $0.0725/hr on-demand in `us-east-1`, plus ~12% for EKS Auto Mode), or
about $119 doubled for headroom. Against a $249 Business tier that is a quarter
of one subscription. Decide the two separately: the reservation is a correctness
fix, the replica is a capacity purchase.

against the demand-derived ladder (the ratios are period-independent, so this
reads the same whatever window D7 picks):

| Tier | Cap/month | Share of the ENTIRE pool |
|---|---|---|
| Developer | 3,000 | 5% |
| Pro | 9,000 | 14% |
| Team | 24,000 | 37% |
| Business | 60,000 | **93%** |
| Enterprise | 135,000 | **208%** |

**D12 later flattens the wall-minutes column, which halves the top of this
table:** the same five rows become 7 / 17 / 35 / 69 / 104%. That takes Business
out of the problem entirely and leaves Enterprise marginally over. The analysis
below is written against the figures above, because the SHAPE of the problem is
what matters and it survives the reladdering — one tier still exceeds the pool,
and supply still has to move.

**One Enterprise tenant's cap is twice the platform's total capacity** —
undeliverable with no other tenant on the system at all. One Business tenant
leaves 4,800 vCPU-minutes a month for everybody else. Two Team tenants take 74%.

**This is not ordinary oversubscription.** Selling more than you have is normal
and healthy where nobody uses their whole cap — that is exactly the reasoning
behind the storage plan's `StorageCommitmentExceedsCapacity`, which fires only
past ~10x. Here the top tier's cap cannot be met *in isolation*, and the failure
mode is different in kind: a full disk stops everyone, while a saturated build
pool QUEUES everyone. The quota as designed caps a VOLUME and says nothing about
concurrency, so two tenants with budget to spare still wait behind one buildkitd.

**Scaling the ladder down does not work, and that is the useful finding.** Hold
Enterprise to half the pool (32,400/month) and the whole table scales by 0.24:
Developer lands at 720 credits/month, which at 20 wall-minutes and 1.5 vCPU is
**24 builds a month** against a `plugins` cap of 100 — so `cpuCredits` would
become the binding limit on the cheapest tier, which is exactly the inversion
Phase 1 rejected when it rejected the first draft's numbers. The ladder and the
shipped capacity are not reconcilable by re-picking numbers.

So SUPPLY is the variable that has to move, and the plan must say by how much:

- Enterprise's 135,000/month needs `135000 / (1440 x 30) = 3.125` vCPU of
  buildkitd running flat out, with zero headroom and nothing left for any other
  tenant. **After D12 the same row is 67,500 and needs 1.5625 vCPU** — five times
  the reserved 0.3, but inside a single `c7g.large`.
- Allowing a single tenant at most HALF the pool — a floor worth stating, since
  anything above it means one customer can starve the rest — needs **≥ 6.25
  vCPU**.
- At the shipped 1.5 vCPU the honest top tier is Business-sized (60,000/month)
  and only if it is the sole tenant building — and that is against the CEILING.
  Against the reserved floor the honest top tier is Pro. **After D12 both improve
  by about a rung:** the ceiling covers Enterprise to within 4%, and the reserved
  floor honestly covers Pro's 11,250 at 87% of it.

**And here is the part that reframes this whole decision: the fix is cheap.**
Priced at us-east-1 on-demand (checked October 2026), a vCPU-hour is ~$0.036 on
Graviton (`c7g.large`, $0.0725/hr for 2 vCPU) and ~$0.045 on x86
(`c7i.large`, $0.0892/hr); EKS Auto Mode adds ~12% on top, and charges it at the
on-demand rate even under a Savings Plan. So:

| Reserved capacity | Serves | Cost/month (c7i, +Auto Mode) |
|---|---|---|
| 1.5 vCPU (today's limit) | Business, as sole tenant | ~$55 |
| 3.125 vCPU | Enterprise, as sole tenant | ~$114 |
| 6.25 vCPU | Enterprise at half the pool | ~$228 |

**Removing this constraint entirely costs on the order of $150–180 a month more
than the platform spends today**, against a single Enterprise subscription at
$899. So D9 is a PROVISIONING decision with a known and small price, not a
product limit — and it should be read that way rather than as a reason to shrink
the ladder. The revenue side makes the same point: the ceiling's 64,800
credits/month sold as packs at $2.49 per 500 is ~$323/month against ~$55 of cost.

What stays true is the discipline, not the pessimism: the ladder must not be
published without the check below, because the failure mode of getting it wrong
is selling a cap nobody can serve.

**This is two problems wearing one label, and they have different natures.**
Keeping them fused is what makes the decision read as unresolvable:

- **Single-tenant deliverability.** Any tier's cap must be reachable by that
  tenant alone on an otherwise-idle platform. This is a correctness property, not
  a business judgement — a cap nobody can ever reach is a false advertisement
  whatever the load — so it belongs in a TEST, and it is decidable today.
- **Aggregate oversubscription.** The sum of sold caps against the pool. This one
  is ALLOWED to exceed 1.0, and healthily so: the storage work's
  `StorageCommitmentExceedsCapacity` fires only past ~10x. It belongs in an
  ALERT, and its threshold needs measured utilisation, which is open item 11.

Treating 93% and 208% as one finding is what stalled this decision. The first is
a bug to fix before publishing; the second is a dial to watch afterwards.

**What to build, rather than what to assert:**

1. Read the vCPU figure from configuration, which D2 already requires, and
   derive `periodSupply = buildkit_vcpu x 1440 x periodDays` from it.
2. A boot-time check and a test: `max(tier cpuCredits) <= periodSupply x
   SINGLE_TENANT_SHARE`. **And a second check this decision originally missed:
   the FREE-TIER AGGREGATE.** Developer's 4,500/month against a 64,800 ceiling
   means 14 fully-consuming free organizations are the whole platform, and free
   organizations are the population a developer platform has most of. A
   single-tenant bound says nothing about that. D11 is the structural answer —
   priority rather than quota — but the number is worth watching either way. A deployment whose ladder exceeds its own capacity
   should refuse to sell the tiers it cannot serve, or at minimum say so loudly
   at startup — the same shape as the tier-config echo already in the quota
   service's boot path.
3. The sold-vs-supply gauge and alert, copied from the storage work rather than
   invented: `quota_cpu_credits_committed` over `periodSupply`, warning
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

## D10 — The budget must cover a MONTH of normal activity, with room for a burst

**Decision: size every tier so a standard month of work fits with roughly 3x
headroom, and state the activity model rather than the number.**

The ladder was derived from the `plugins` cap — one internal number from
another — which says nothing about whether a customer can get a month's work
done. This is the requirement that makes the table answerable, and it follows
`AUTOMATION_CALLS_SIZING`'s example of writing the arithmetic down "so the next
person argues with the arithmetic, not with the numbers".

**What a normal month looks like.** A tier's `plugins` cap is a per-3-day build
RATE, so it already asserts a monthly build count (x10). Normal activity is not
the cap — the cap exists for peaks — so take normal as **30% utilisation**:

| Tier | Builds/month at the cap | Normal (30%) | x 30 wall-min x 1.5 vCPU | Normal credits/month |
|---|---|---|---|---|
| Developer | 100 | 30 | 45 | **1,350** |
| Pro | 250 | 75 | 45 | **3,375** |
| Team | 500 | 150 | 45 | **6,750** |
| Business | 1,000 | 300 | 45 | **13,500** |
| Enterprise | 1,500 | 450 | 45 | **20,250** |

Against the Phase 1 ladder those land at a uniform **3.3x headroom** — the same
factor on every tier, because both sides are linear in the same two assumptions.
D12's flattening leaves that multiple untouched, because it scales the ladder and
the normal month by the same factor; only the figures above move.
So the answer to "is it enough for a month of standard activity?" is **yes, in
aggregate, with room for a month that runs three times hot.**

**The aggregate was never the problem; the SHAPE was.** The same figures under a
one-day window refuse a Pro account's release day while it holds 10,125 unspent
credits — see D7, which this decision reverses to a monthly period for exactly
this reason. A budget that covers a month of normal activity has to be spendable
the way a month of normal activity actually arrives: unevenly.

**Two consequences worth naming:**

- **The 3.3x is a utilisation assumption, not a measurement.** It is the one
  number here nobody has evidence for, and it is checkable the moment Phase 2
  ships: `cpu_credits_charged_total` per org against the tier cap gives real
  utilisation, and the ladder should be re-derived from it rather than from 30%.
  Until then, 30% is a stated guess and should be labelled as one in the docs.
- **It makes D9 worse before it makes it better.** A monthly window lets a tenant
  spend a month's budget in an afternoon, so the quota stops bounding
  instantaneous demand at all and the build queue becomes the only limiter — and
  bursts COINCIDE across tenants, because everyone bumps the same base image
  after the same CVE. D9's unmodelled concurrency is therefore not a footnote;
  it is the next thing to design.

## D11 — A build class on every tier, graded by mix

**IMPLEMENTED, and the vocabulary moved into a catalog.**
`BUILD_CLASSES = ['standard', 'flexible']` now lives in api-core
`types/build-catalog.ts` together with its labels and the 1/3 · 2/4 · 3/6 · 5/10
· 8/16 slot mix. The per-org semaphore holds **one counter per class**
(`pb:org-build:<org>:<class>`), and `maxBuildsPerOrg(tier, class)` replaced the
flat `PLUGIN_MAX_BUILDS_PER_ORG` — each cell overridable as
`PLUGIN_MAX_BUILDS_<TIER>_<CLASS>`.

**On the name: `flexible`, not `batch`, `deferred`, `basic` or `small`.** It names
what the CUSTOMER trades — a flexible start time — rather than what the platform
does with it, and it does not read as a demotion, which matters because this
class is on every tier including free. `deferred` reads as broken and `basic`
reads as a tier. `small` was rejected outright: it is a magnitude word on a
LATENCY dimension, so `{ buildClass: 'small', buildSize: '2x' }` would be legal
and unreadable, and it collides with `ComputeType.SMALL`, which after Phase 4
feeds the same `cpuCredits` ledger at 2 vCPU.

**On the catalog: one keyed module replaced six tables.** The ids and multipliers
were in `wire-vocabulary.ts`, the tier gate and slot counts in `quota-tiers.ts`
(not browser-importable, because it reads env), and a hand mirror of all four in
`frontend/src/lib/build-shape.ts` — policed by a test that parsed api-core's
TypeScript SOURCE with regexes. The catalog is dependency-free and
subpath-exported (`@pipeline-builder/api-core/build-catalog`), exactly as
`quota-catalog` is, so the browser imports it and **the mirror and its drift test
are deleted rather than improved**. The catalog holds DEFAULTS only; the env
overlay stays in `maxBuildsPerOrg`, because one `envInt` call in that module
would end its browser-importability and bring the mirror back.

Three things were only visible once it was built:

- **the owner hash had to carry the class, not just the org.** The scrubber
  reclaims by walking `jobId -> owner`, and with the org alone it could not tell
  which of the two counters a vanished job had taken — reclaiming from the wrong
  one leaks the real slot AND walks the other counter toward its negative clamp.
  The value is `org|class`, split on the LAST separator so an org id containing
  one still parses, and an unrecognised suffix is treated as part of the org id
  rather than trusted as a class.
- **separate counters are the whole point, not an implementation detail.** With
  one shared counter `batch` becomes a way to starve `standard`: an org that
  fills it with ten cheap batch builds has no slot left for the urgent fix the
  standard class exists to carry. A test pins this.
- **the refusal copy had to change with the caps.** "At its limit of 3 concurrent
  builds" was true of neither class once the caps diverged, so both the SSE
  `WARN` and the terminal `UnrecoverableError` now name the class and its own
  cap, and the terminal one names the OTHER class as the alternative.

Everything the metrics side needed is labelled: `plugin_job_wait_seconds`,
`plugin_build_slot_denied_total`, `plugin_build_slot_timeout_total`,
`plugin_build_slot_reclaimed_total` and `cpu_credits_charged_total` all carry
`build_class`, and the three slot alert rules group by it — which also forced a
real fix to `PluginQueueProcessingSlow`: it is now scoped to
`build_class="standard"`, because `batch` is EXPECTED to wait and a mixed p95
would fire on a platform that is merely busy with deferred work while hiding a
genuine standard-class stall inside the mixture.

**Decision: offer builds a "run when there is room" class on EVERY tier, grade
the tiers by how many standard versus batch builds they may run at once, and
decide the class's PRICE separately from its existence.** The class is what
smooths load and drives conversion, and it should not wait on a multiplier that
turns out to do almost nothing.

An earlier revision made the free tier batch-ONLY. That is reversed here, for
reasons the catalogue and the code both supply — see "Why not batch-only"
below. The graded form keeps every benefit the carve-out was reaching for.

This is the one lever the plan was missing, and it was missing because the plan
was written looking inward. Both obvious comparables sell latency tolerance:

- **Claude's Batch API — 50% off** for accepting a 24-hour asynchronous window.
- **AWS Spot — roughly 70% off** for accepting interruption.

Same trade in both cases: the customer gives up immediacy, the vendor gets to
smooth its own load. Every discount this plan currently has is a VOLUME discount
(buy more, pay less per unit) or a prepayment discount, and neither of those
helps the platform at all — they reduce revenue without reducing cost or
smoothing demand.

**Builds are the right candidate, but the mechanism is not the one an earlier
revision assumed.** That revision said builds "go through BullMQ, which carries a
priority already", so there was nothing to invent. BullMQ does carry a priority;
**this build path uses none**, and priority is the wrong primitive here anyway.
What the path actually has is more elaborate than a priority and less useful than
one:

- **Six per-tier queues and six workers** (`TIER_QUEUE_NAMES`, one per
  `QuotaTier` including `unlimited`), each with its own concurrency knob
  `PLUGIN_BUILD_CONCURRENCY_<TIER>` — `plugin-build-queue.ts:184`.
- **A per-org Redis/Lua semaphore**, `PLUGIN_MAX_BUILDS_PER_ORG`, defaulting to
  **3 for every tier alike**, with a 10s delayed-requeue backoff —
  `slot-manager.ts:28`.
- `plugin_job_wait_seconds` already observed, and a DLQ with its own worker.

**The catch is that none of that layer controls the scarce resource.** All six
workers run in one process, in one pod (`replicas: 1`), feeding **one buildkitd
sidecar** at `limits 1500m` / `requests 300m` behind a per-pod `BUILDKIT_HOST`.
So per-tier concurrency partitions JOB SLOTS, not compute: the number of
concurrent builds is the sum of the six, and they all contend for the same
1.5 vCPU. A batch class built from a priority or a lowered concurrency
therefore changes who STARTS, not who GETS CORES — and cores are what is being
rationed.

**So the class has to be a job field plus per-class admission inside the worker,
checked where the resource is.** Not a seventh queue, and not a BullMQ priority
integer, which has no meaning across six separate queues.
`PluginBuildJobData` carries no class today, so this is a payload addition of
about Phase 1's size rather than a free ride on existing machinery.

**And the first real lever is already there, set flat.** This decision's
conversion argument is that Developer to Pro should buy PRIORITY — but
`PLUGIN_MAX_BUILDS_PER_ORG` gives a Developer org the same three in-flight builds
as Enterprise. Making it tier-aware is exactly the shape the concurrency map
beside it already has, needs no new queue topology and no billing change, and
delivers most of the conversion story on its own. **Do that before building a
batch class, not after.**

**Grade the MIX, not the availability.** Split the per-org slot cap in two, so
every tier has both classes and the tiers differ in how much of each they get:

| Tier | Standard in-flight | Batch in-flight | Today |
|---|---|---|---|
| Developer | 1 | 3 | 3 flat |
| Pro | 2 | 4 | 3 flat |
| Team | 3 | 6 | 3 flat |
| Business | 5 | 10 | 3 flat |
| Enterprise | 8 | 16 | 3 flat |

The numbers are illustrative (open item 13 settles them); the shape is the
decision. Batch headroom exceeds standard on every row, so the cheap class is
where the room is — which is what actually smooths load — while a free account
can still push one urgent fix through the standard class.

**Three problems this answers, and what carries each:**

1. **The free-tier aggregate D9 never checked.** Developer holds 4,500 credits a
   month against a pool ceiling of 64,800, so **14 fully-consuming free
   organizations are the entire platform**, and D12 made that worse by a third
   — the figure was 22 before the ladder was flattened. **But the bound for this
   already exists and is not a class at all:** there is ONE `Worker` per tier with
   `concurrency: tierConcurrency[tier]` in a `replicas: 1` pod
   (`plugin-build-queue.ts:489`), so `PLUGIN_BUILD_CONCURRENCY_DEVELOPER` caps
   concurrent free builds PLATFORM-WIDE across every free org, whatever the quota
   says. D9 wrote that "a single-tenant bound says nothing about the aggregate";
   the per-tier worker concurrency is exactly that aggregate bound, already built.
   Set it deliberately rather than removing a class to do its job.
2. **It de-correlates D9's bursts.** The coincidence D9 worries about — everyone
   rebuilding after the same CVE or base-image bump — is what a batch class
   spreads out, and the free tier is where most of that volume will be. The graded
   mix delivers this better than a carve-out: free accounts sit mostly in the
   batch class because that is where their slots are, not because standard is
   forbidden.
3. **It gives Developer → Pro a reason that is not volume.** The upgrade buys
   MORE STANDARD SLOTS — priority graded the way every other dimension in the
   catalogue is graded, rather than priority switched on. Both comparables do the
   graded version too: AWS's free tier is burstable t-class rather than
   compute-less, and Claude rate-limits its free tier hardest rather than refusing
   it synchronous calls.

### Naming: standard and BATCH, not basic

The two classes are **standard** and **batch**. Three pairs were weighed, and the
words are already spoken for in ways that decide it:

- **`basic` / `standard` loses on meaning rather than on taste.** The built image
  is byte-identical in both classes; only the start time differs. "Basic" implies
  a lesser ARTEFACT, so a buyer reasonably asks what a basic build leaves out and
  the answer is nothing. It also introduces a second ranking vocabulary beside
  developer / pro / team / business / enterprise, so "the basic class on the Pro
  tier" puts two ladders in one phrase. `basic` is unused in the codebase, which
  is the only point in its favour.
- **`standard` / `deferred` was the earlier pair and is not parallel.**
  "Standard" names a rank and "deferred" names a mechanism, so neither word
  implies the other. "Deferred" is accurate, which is why it survives in prose
  about what the class DOES — just not as its name.
- **`standard` / `batch` is the pair, because it is the comparable's own
  vocabulary.** This decision anchors its discount to Claude's Batch API at 50%
  off, and Anthropic's own contrast is precisely batch against standard. Both
  words describe SCHEDULING rather than rank or quality, which is the axis the
  class actually varies on, and "batch build" is legible to an engineer without a
  glossary.

**Two costs, both accepted.** `standard` already names a support level
(`support_standard`) and a compliance level (`compliance_standard`), so the
catalogue now holds three Standards — always qualify it as a BUILD CLASS in copy.
And `batch` appears in `bulk-plugin.ts`'s comments for bulk operations; the
user-facing word there is "bulk", so keep the two apart in copy rather than
renaming either.

### Why not batch-only

The carve-out was the earlier decision, and four things argue against it:

- **Its main job is already done by an existing knob.** Argument 1 above: the
  per-tier worker concurrency is a direct, platform-wide aggregate bound on free
  builds. Removing a class to solve a problem a knob already solves is the wrong
  instrument.
- **No other dimension in the catalogue is ABSENT on a tier.** Every row is
  graded — `dashboards` 20 / 200 / unlimited, `idpConfigs` 1 / 5 / 5 / 10 /
  unlimited. Nothing is unavailable; things are smaller. A one-value enum is not a
  class, it is a restriction wearing a class's name, and it reads as a crippled
  free tier rather than the bottom of a ladder.
- **It is not enforceable yet, so today it would be a label.** Per the mechanism
  section above, the queue layer does not control cores: a batch build that has
  STARTED contends at buildkitd exactly like a standard one. Until the
  standard-class capacity floor exists, "batch-only" reorders starts and
  changes nothing about contention.
- **Neither tier knob has ever been tuned.** All six
  `PLUGIN_BUILD_CONCURRENCY_<TIER>` values default to the same global
  `concurrency`, and `PLUGIN_MAX_BUILDS_PER_ORG` is 3 for every tier. The tier
  differentiation this machinery was built for is entirely unused — a far
  cheaper place to express tier than a class carve-out.

**What the reversal costs, and the one thing to watch.** The conversion line
softens from "upgrade to get priority" to "upgrade to get more priority" —
weaker rhetorically, but it is the model every other dimension uses. And because
Developer can now use the standard class, free builds draw on the reserved
standard floor: either split that floor paid/free, or set
`PLUGIN_BUILD_CONCURRENCY_DEVELOPER` low enough that the free draw is bounded by
construction. The second reuses a knob that already exists and is the simpler
answer.

**The credit multiplier is close to inert, and that is a finding rather than a
quibble.** D12 derives credits FROM the `plugins` cap, so the two bind
SIMULTANEOUSLY at 1x on every tier by construction: Developer is 100 builds by
`plugins` and 4,500 / 45 = 100 builds by credits. Any multiplier below 1x makes
credits non-binding and leaves `plugins` the only cap that bites, so a batch
build costs the customer nothing they were not going to spend anyway.

Credits bind only for a customer whose builds run LONGER than D12's assumed 30
minutes. A batch discount on credits is therefore not a volume discount at all
— it is a discount on SLOW BUILDS, and it is inert for exactly the high-volume
population this decision set out to attract and smooth.

**Which splits this decision in two, to be decided separately:**

- **The class itself** — per-class admission, the graded standard/batch slot
  mix, tier-aware per-org slots. This is what does the load-smoothing and the
  conversion, and none of it needs a price.
- **The credit multiplier** — a discount whose only effect is on customers whose
  builds exceed the assumed average. Worth having, but price it as what it is
  rather than as a volume lever, and do not let the class wait on it.

**The wait promise cannot be computed yet, which makes it the hardest part.**
`plugin_job_wait_seconds` already measures the wait, so the instrumentation is
there — but on a single buildkitd with no admission control and no queue-depth
backpressure the worst case is unbounded, and a bound nobody enforces is not a
promise. Enforcing it means **reserving a floor of buildkitd capacity for the
standard class**, so the batch queue drains at a known rate and "batch
yields to paid" becomes true at the resource rather than at the queue. That is
D9's reservation work approached from the other end.

**One interaction to fix before deferring anything: a queued build holds a
reserved `plugins` slot.** The job carries a `quotaReleased` flag and there is a
`releasePluginQuota`, so the slot is held across the job's life. A batch build left
queued for hours consumes a slot of a THREE-DAY flow quota without running — and since
Developer's slots are mostly batch under the graded mix, a free org can tie up
most of its `plugins` budget in a queue. Reserve at DEQUEUE for the batch class, or exclude the
queued interval from the reservation window.

**What is left that is purely a product call:** the multiplier (Claude's 50% is
the natural anchor, and anything cheaper than the upgrade it competes with
works), the stated worst-case wait, and an honest refusal when the batch queue
is genuinely saturated.

**What it is NOT.** Not preemption: a batch build that has started should
finish, because killing it wastes the credits already spent (the same reasoning
as "it does not kill running builds"). Spot's interruption model is wrong here —
the cost of a lost build is borne by the tenant, not the platform.

**And it has an obvious twin this plan cannot express: a FASTER class.**
CircleCI sells resource classes (small/medium/large/xlarge) and GitHub sells
larger runners; in both cases the customer buys more cores for one build and
pays proportionally — CircleCI's rate is flat per vCPU-minute across every
class, so the class is packaging, not pricing. Here `buildkit_vcpu` is a single
GLOBAL value set by the operator (D2), so a tenant with a slow build can only
wait. There is no way to pay for a faster one.

That is a product gap rather than a defect in this plan, but it is the natural
companion to the decision above: D11 sells latency tolerance, and a resource
class sells latency intolerance. The two together are the whole axis both
competitors monetise, and this plan currently has one end of it. Designing it
means making the allocation per-build rather than per-deployment, which changes
D2's "shared sidecar" premise and D9's supply arithmetic — so it is a separate
decision, listed in the open items rather than assumed here.

**But it shares a prerequisite with D9, which an earlier revision missed.**
buildkitd is a SIDECAR of the plugin pod behind a per-pod `BUILDKIT_HOST`, so
scaling build compute means scaling the API deployment. A resource class needs
buildkitd decoupled into a runner of its own — which is exactly what D9's supply
ramp needs, and what the reserved standard-class floor above needs. These were
listed as independent decisions; they are one piece of infrastructure work with
three products on top of it, and sequencing them separately means doing it three
times.

## D12 — Flatten the wall-minutes column

**Decision: charge every tier the same 30 wall-minutes per build, rather than
ramping 20 / 24 / 32 / 40 / 60 by tier.**

The ramped column was the softest number in the model — an earlier revision
called it "the only judgement left" — and it turned out to be load-bearing for
all three of the problems D9, Phase 3b and Phase 3d were left holding. Flattening
it resolves part of each at once, which is why it is a decision of its own rather
than a parameter tweak.

**The ramp double-counts tier.** A tier's build COUNT already scales with
`plugins`, so scaling the per-build COST by tier as well makes credits
superlinear in tier on the strength of a claim nobody has measured. Pro to
Enterprise was 6x the builds and 2.5x the minutes — 15x the credits for a 23x
price step. And the justification offered for the ramp, that larger customers
build larger images, attributes to the PAYER what belongs to the PROJECT: a
Developer account and an Enterprise account building the same multi-stage Java
image take the same minutes.

**The resulting ladder:**

| Tier | Builds / month | `cpuCredits` / month | Was | Share of the 64,800 ceiling |
|---|---|---|---|---|
| Developer | 100 | **4,500** | 3,000 | 7% |
| Pro | 250 | **11,250** | 9,000 | 17% |
| Team | 500 | **22,500** | 24,000 | 35% |
| Business | 1,000 | **45,000** | 60,000 | 69% |
| Enterprise | 1,500 | **67,500** | 135,000 | **104%** |

Every row is `builds x 30 x 1.5`, so a credit grant is `builds x 45` on every
tier — one number instead of five.

**Three things this fixes:**

1. **D9's top rows.** Enterprise falls from 208% of the pool ceiling to 104% and
   Business from 93% to 69%. One row still breaches, and only just.
2. **Phase 3b's under-grant.** A pack's credit grant was tier-dependent under the
   ramp — `plugin_pack`'s +10 builds needed 3,000 credits on Developer and 9,000
   on Enterprise — and neither the catalogue's flat grant object nor the scalar
   `_GRANT` override can hold five numbers. Flat minutes reduce it to one figure.
3. **Open item 4.** It deletes the judgement rather than answering it.

**What it does NOT fix, and this is the important half.** At 1,500 builds a month
Enterprise needs **at least 45,000 credits even at 20 wall-minutes** — the build
count sets the floor. No setting of this column makes the top tier fit inside the
shipped pool, so D9's provisioning decision stands on its own. Flattening makes
that decision cheap; it does not remove it.

**One cost to accept deliberately.** Flat minutes make the top tiers less
generous on credits relative to price: Pro to Enterprise becomes 6x the credits
for a 23x price step, where the ramp gave 15x. That is the correct trade if
credits are not what Enterprise is buying — it buys seats, unlimited
dashboards and alert rules, unlimited IdP configurations and support — and packs
cover the rest. But if a top tier does need more minutes, **raise its row
explicitly rather than reaching back for the ramp.** The failure mode to avoid is
burying a commercial choice inside an engineering parameter: a stated allowance
can be argued with, while a per-tier wall-minutes assumption reads like a
measurement.

## D13 — Two class dimensions: scheduling, and MACHINE SIZE

**IMPLEMENTED as a five-rung ladder with word labels over arithmetic ids:**
`0.5x · 1x · 2x · 4x · 8x`, shown as **Small · Standard · Medium · Large ·
X-Large**. The ids keep the multiplier so the credit math is checkable by eye and
`buildSizeMultiplier` needs no lookup table to verify; the labels are what a
person reads, and relabelling costs one catalog field with no wire value, Redis
key, metric label or ledger string behind it.

**`Small` (0.5x) is on every tier, and it is a budget option rather than a
restriction.** The arithmetic only runs one way in each direction: above Standard
a build that parallelises costs about the same and one that does not costs the
multiple, so a bigger machine can never cost LESS; below Standard a CPU-bound
build takes twice as long at half the vCPU and costs the same while an I/O-bound
one costs about half, so Small can never cost MORE. (That holds while slowdown is
at most linear, which memory pressure can break.) It also answers the
crippled-free-tier objection from the other direction: Developer now has a real
choice to make instead of a list of locks.

**Small defaults into the `flexible` class** (`defaultClassForSize`), because a
half-speed build holds its slot about twice as long — on Developer's single
standard slot that would block the only urgent-fix slot for double the time. The
UI is therefore ONE select over five named machines plus a deferral toggle, not
two dropdowns; the toggle keeps `flexible` + `Large` expressible, which is a
legitimate nightly image and a cell a preset list would have pushed into
`standard`, the worst one for the platform.

**A machine with no pool behind it is REFUSED at submission.** That is the fix to
a defect this work shipped and nearly kept: `getBuildkitAddrForBuild` falls back
to the shared daemon, so a `4x` build was charged four times and delivered one
times. `0.5x` would have been worse in the other direction — full speed at half
price, a blanket discount on every build a tenant would find within a day.
`buildPoolConfigured` now gates it, and `1x` needs no pool because it IS the
shared daemon.

**The deadline scales below Standard** (`buildTimeoutFactor`): `timeoutMs ×
max(1, 1/multiplier)`, up but never down. At 0.75 vCPU a ten-minute build becomes
about twenty and would die on the 15-minute `DOCKER_BUILD_TIMEOUT_MS` — a
`retryable` failure, so not charged, but retried twice and dead-lettered, which
would make Small quietly fail long builds. Scaling it DOWN at `4x` would instead
break I/O-bound builds that gain nothing from the extra CPU. A pleasant
consequence: because the deadline scales by `1/multiplier` and the charge by the
multiplier, **the per-build credit ceiling is identical at `0.5x` and `1x`**, so
Small cannot raise the worst case.

**A size is a BIGGER DAEMON, not a flag.** `buildctl` has no per-build CPU
option, because the CPU a build may use is the buildkitd POD's limit. So
`getBuildkitAddrForBuild(tier, size)` routes to
`PLUGIN_BUILDKIT_ADDR_SIZE_<SUFFIX>`, and the suffix is declared in the catalog
rather than derived: `'0.5x'.toUpperCase()` is `0.5X`, and a dot cannot appear in
an environment variable name. (Same reason `x-large` was rejected as an id —
`..._X-LARGE` is not an identifier either.)

**The credit meter charges the multiplier regardless of delivery, and that is
deliberate:** under-provisioned supply must not quietly become a cheaper build.
`creditsForBuild(processedOn, finishedOn, size)` multiplies the vCPU by
`BUILD_SIZE_MULTIPLIER`, which also keeps the meter honest in both directions — a
build that parallelises finishes in about half the wall time and costs roughly
the same (the pitch), and one that does not costs twice as much (the truth). That
second case is exactly why a size is never SUGGESTED without measured per-plugin
speedup: a 4x charge on an I/O-bound build that gains nothing is the complaint
that sticks.

`TIER_BUILD_SIZES` gates ASKING — `2x` from Team, `4x` from Business — and a
request above the ceiling is **refused, not downgraded**. A silent downgrade
means the tenant waits twice as long as they asked for with nothing saying why,
and a CI job pinning `4x` for a nightly image would keep "succeeding" at `1x`
forever. Both build-queuing routes resolve through one `resolveBuildShape`, so
they cannot answer differently; an unrecognised tier degrades to the DEFAULT
tier's gate (the smallest allowance) rather than turning a tier lookup into a
500, which is the same call `tierForQueueName` already makes.



**Decision: keep the scheduling class binary (standard / batch) and put the
ladder on a SECOND dimension — machine size, named by its vCPU multiple
(`1x` / `2x` / `4x`) — gated by tier rather than priced by a multiplier.**

This answers "more classes than two". The answer is not a longer scheduling
ladder, for a reason worth writing down, and the second dimension turns out to be
nearly free to price.

**Why NOT a three-step scheduling ladder.** The obvious expansion is
`batch` / `standard` / `priority`. It fails twice:

- **A latency class only differentiates under contention.** On an idle platform a
  priority build starts at the same moment a standard one does, so the customer
  pays for something worth nothing most of the time and valuable exactly when
  they cannot predict it. Queue position is not a product.
- **`priority` is already a support level** (`support_priority`), which would put
  a third meaning on a word the catalogue uses twice already.

**Why machine size is the right ladder, and why it costs nothing to price.** D11
already notes that "CircleCI's rate is flat per vCPU-minute across every class,
so the class is packaging, not pricing". With a credit DEFINED as a vCPU-minute
(D2), that property falls out for free:

> A build taking 20 wall-minutes at 1.5 vCPU costs 30 credits. The same work at
> 3 vCPU takes about 10 wall-minutes and costs about 30 credits.

**The customer pays the same and gets it sooner, and the platform spends the same
vCPU-minutes either way.** So machine size needs no multiplier, no new pricing
surface and no change to D12's ladder — the meter already charges it correctly.
What varies is WHICH sizes a tier may request, and that is a capability gate of
exactly the shape `idpConfigs` and the bundle availability sets already use.

| Size | vCPU | Credits per wall-minute | Gated to |
|---|---|---|---|
| `1x` | 1.5 | 1.5 | every tier |
| `2x` | 3 | 3 | Team and above |
| `4x` | 6 | 6 | Business and above |

Illustrative gates (open item 15). Naming them by the vCPU multiple rather than
`small` / `medium` / `large` is deliberate: **`medium` is already a severity in
this very service** — vuln scan counts, `CRITICALITY_LEVELS`,
`HeuristicSeverity` — so "a medium build" would sit beside "medium findings"
exactly where a reader is least able to tell them apart. `1x` / `2x` / `4x` also
states the credit rate in the name, which is the one fact a buyer needs.

**The honest problem: builds do not parallelise linearly.** A build that is
I/O-bound, network-bound or single-threaded gains little from `4x` and is charged
four times the credits per minute regardless, so a size can cost a customer four
times as much for no gain. That is the one way this dimension makes somebody
angry, and it needs three things rather than a disclaimer:

- **Measured per-plugin data before recommending a size.**
  `plugin_build_duration_seconds` is already observed per org; the same
  observation per plugin at a known vCPU is what makes "this plugin got 1.6x
  faster at 2x" answerable instead of a guess.
- **F5's hint must show the TRADE, not just the cost:** "about 30 credits at 1x
  (~20 min), or 30 credits at 2x (~12 min, measured on this plugin)".
- **Default to `1x` and make size opt-in PER PLUGIN**, never per account, so
  nobody is silently moved onto a size their build cannot use.

### Label the GATE, not the class

The tier relationship is real and currently UNNAMED: `2x` is Team and above, `4x`
is Business and above, and nothing in the vocabulary says so. Fix that in
presentation rather than in the names.

- **Render a size with its gate attached** — `2x · Team and above` — wherever a
  size is offered or refused, so the upgrade path is legible at the point of
  choice instead of in a pricing table somebody has to go and find.
- **Give the tier matrix an "available sizes" row**, so the ladder reads as a tier
  benefit alongside every other graded dimension:

| | Developer | Pro | Team | Business | Enterprise |
|---|---|---|---|---|---|
| Available sizes | `1x` | `1x` | `1x` `2x` | `1x` `2x` `4x` | `1x` `2x` `4x` |

- **Group them under "what your plan can run"** at submission, with the gated
  sizes VISIBLE but disabled. A size the account cannot use should be shown and
  locked rather than hidden — the same disposition the frontend already applies
  to tier-gated navigation, which locks rather than hides.

### Rejected: naming the classes after tiers

"Developer class", "Pro class" and so on was proposed and rejected. Recorded
because the reasoning generalises to any later proposal to fold a usage dimension
into the subscription:

- **It re-creates the one-value enum this plan just removed.** D11 reversed
  batch-only Developer precisely because a class with a single value on a tier is
  a restriction rather than a class. If the class IS the tier, every tier has
  exactly one, and the dimension carries nothing the tier did not already carry.
- **It removes the CHOICE both mechanisms depend on.** Load smoothing works
  because a customer volunteers for a wait on a particular build; wall-clock speed
  sells because they pick a size per build. Both need a per-build decision that a
  tier-derived class cannot express.
- **`TIER_QUEUE_NAMES` already names queues after tiers**
  (`plugin-build-developer`, `plugin-build-pro`, ...), so a tier-named class would
  give a customer-CHOSEN thing the same vocabulary as an existing
  billing-DERIVED one, inside the same service.
- **Tier names churn and class names should not.** The tier set has already been
  restructured once (developer / pro / team / enterprise) and extended once
  (business). Tying class names to tier names makes every future tier change
  rename a user-facing, API-visible, metric-label-visible identifier, with no shim
  to soften it.
- **It would make D11's `class` metric label redundant**, duplicating the `tier`
  dimension the ledger already carries, so "what fraction of credits ran as
  batch?" would stop being answerable.

**It is downstream of the same prerequisite as everything else here.** Per-build
vCPU allocation needs buildkitd decoupled from the plugin Deployment — which is
D9's supply ramp, D11's capacity floor and open item 9, all one piece of work.
This decision adds no new prerequisite; it adds a third product on the one
already listed.

**And it closes open item 9 as a question.** That item asked whether to sell a
faster class at all. The answer is yes, because the pricing is already correct
and the only blocker is infrastructure that three other items need anyway — what
remains is the tier gates (item 15), not the decision.

## Phase 1 — The quota type

- Add `cpuCredits` to `QuotaType` and `VALID_QUOTA_TYPES`, then fill the tables
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
  fails the build. The per-tier override `QUOTA_TIER_<TIER>_CPU_CREDITS` comes
  free with `tierLimitEnv`; `QUOTA_RESET_DAYS_CPU_CREDITS` (the per-type
  period), `QUOTA_CPU_CREDITS_GRACE_PCT` (the band) and the buildkit vCPU
  figure each need their own entry.

**Tier sizing — DERIVED, so the argument is about the principle.** An earlier
draft picked a number per tier and asserted it was "generous relative to the
`plugins` count quota". Checked against the real limits (10 / 25 / 50 / 100 /
150) that was true on four tiers and false on the one that matters: it gave
Developer **8 wall-minutes per permitted build** against 24–67 everywhere else,
so the new quota became the binding constraint on the only tier that cannot pay —
and on the tier where builds are *slowest*, with no warm cache and someone
iterating on a Dockerfile.

So the ladder is derived rather than chosen. The budget is **per month** (D7)
while `plugins` is per three days, so the derivation goes through builds per
month:

> `monthly credits = (plugins_limit x 10) x per-build wall-minutes x buildkit_vcpu`

| Tier | `plugins` / 3 days | Builds / month | Wall-min per build | `cpuCredits` / month |
|---|---|---|---|---|
| Developer | 10 | 100 | 30 | **4,500** |
| Pro | 25 | 250 | 30 | **11,250** |
| Team | 50 | 500 | 30 | **22,500** |
| Business | 100 | 1,000 | 30 | **45,000** |
| Enterprise | 150 | 1,500 | 30 | **67,500** |
| Unlimited | — | — | — | `-1` |

Every row is exact at `buildkit_vcpu = 1.5`. D10 checks these against a month of
normal activity and finds a uniform **3.3x headroom**, which is the point of the
sizing: a standard month fits, and a month that runs three times hot still fits.

**The table is a DEMAND model, and supply is a separate gate.** Nothing in this
derivation looks at what the cluster can deliver. With D12's flattening the top
rows are far closer to it — Business at 69% of the pool and Enterprise at 104%,
against 93% and 208% under the ramped column — but 1.5 vCPU still delivers only
64,800 credits a month, so Enterprise remains just over the line. Treat the
numbers here as the shape of the ladder and D9's deliverability check as the gate
on publishing it.

The wall-minutes column is no longer a judgement: **D12 flattens it to 30 on
every tier.** An earlier revision of this section called it "the only judgement
left" and justified the ramp as larger customers building larger images — a
claim nobody measured, and one that double-counts tier, since build COUNT already
scales with `plugins`. D12 carries the arithmetic and the consequences.

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
- **Emit** `cpu_credits_charged_total{org_id, outcome}` so the charge is
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
  (route, principal, plugin) **plus the build CLASS (D11)**, so "why is our build
  budget gone?" has an answer and the batch discount can be verified to be
  doing what it was sold to do. Without the class label the fraction of credits
  charged at the batch rate is unanswerable; without any of it the quota is
  enforceable but not explainable.

## Phase 3 — The pack

```
b('cpu_credits_pack', 'CPU Credits Pack (+500)',
  '500 additional CPU credits / month', { cpuCredits: 500 },
  249, PAID, <sort>,
  { volumeTiers: SEAT_STYLE_VOLUME, maxQuantity: 22 })
```

**+500 credits a month, granular, with seat-style volume breaks and a quantity
cap.** Each of those four is a decision the earlier drafts got wrong or left
open; the reasoning is below. A pack grant raises the cap per period, so the
monthly period (D7) sets the unit: +500/month is about eleven extra builds at
D12's flat 30 wall-minutes.

Three things to get right, all learned from the existing catalogue:

- **Give it the volume curve.** `plugin_pack`, `api_pack` and `automation_pack`
  all carry `CAPACITY_VOLUME` (10/20/30% at 4/10/25 units). `storage_pack` is the
  one capacity pack without it, at the highest price — an omission, not a
  decision. Do not copy it.
- **PAID tiers only**, like the other throughput packs: a $0 account that can buy
  capacity has no reason to upgrade for capacity.
- **Keep the grant GRANULAR, which is what buys headroom on the only size
  constraint that binds.** `RATE_PACKS` refuses a pack granting more than half
  the cap of any tier that may buy it (`grant > cap / 2`). A coarse pack sized
  at a sixth of Pro's budget sat **exactly on** that bound in an earlier draft —
  passing only because the comparison is strict, and coupling pack size to the
  wall-minutes column that same draft called "the only judgement left". At
  +500 against Pro's 11,250 the pack is **4.4%** of the cap, so Pro's row can be
  retuned without breaking a test. The no-crossing rule is comfortable too
  (11,250 + 500 is nowhere near Team's 22,500).

  An earlier draft also justified its size with a DEVELOPER boundary
  ("100 + 150 = 250, under 300"), which does not apply once the pack is
  PAID-only — and PAID-only is not optional: a separate test asserts
  `storage_pack` is the only capacity pack sold on Developer.
- **Use SEAT-STYLE volume breaks, not `CAPACITY_VOLUME`.** The catalogue encodes
  the rule and an earlier draft read it backwards: `CAPACITY_VOLUME`'s 10/20/30%
  at **4/10/25 units** is sized for a COARSE pack, while `seat` — the one
  granular pack — carries its own, much higher 5/15/40 breaks precisely because
  granularity moves them. Copy `seat`. With 4/10/25 on a +500 pack, a Pro
  account merely doubling its budget buys 18 units and takes **20% off**, and
  anyone topping up seriously clears 25 units and takes **30% off permanently**
  — on the one dimension the platform pays for per unit.
- **Cap the stack at 22, and it is NOT blocked on D9.** `stackable` defaults to
  true, so with no cap an account could buy arbitrarily many minutes against a
  pool that delivers 64,800 a month. D5 added a per-BUILD ceiling for exactly
  this reasoning; this is its pricing-side twin. An earlier revision assumed the
  cap had to come from supply and so deferred it behind provisioning. It does
  not: two bounds apply, and supply is not the binding one.

  | Bound | Pro | Team | Business | Enterprise |
  |---|---|---|---|---|
  | No-crossing, `(next cap - cap) / 500` | **22** | 45 | 45 | — |
  | Supply, at 2 x 1.5 vCPU reserved | — | — | — | 124 |

  Pro's no-crossing bound binds first and is independent of supply: once the pool
  covers the top tier at all — which D9's deliverability invariant already
  requires — pack headroom sits far above 22. So `maxQuantity: 22`, and open
  item 6 closes without waiting for provisioning.

  It does not cannibalise the upgrade either. Twenty-two packs list at $54.78 and
  cost $43.82 after the 20% break past fifteen units, for +11,000 credits; Pro to
  Team is $40.00 for +11,250 credits **plus** double the pipelines and plugins,
  triple the API calls, unlimited dashboards and alert rules, and three seats.
  Upgrading dominates at every point in the range.

  Skip the per-tier `maxQuantity` map. It exists to serve an Enterprise tenant
  needing more than 11,000 extra credits, and that is a supply conversation the
  commitment gauge already surfaces.
- **Declare the pack's unit so it is typed in CREDITS.** `AddonGrid` already
  takes an exact typed quantity and divides the grant by
  `quotaPackUnit(dimension).per` — which is why storage is typed in GB rather
  than in packs. A `cpuCredits` catalog entry with
  `packUnit: { name: 'credits', per: 1 }` makes "enter 2000" mean 2,000 more
  minutes a month, which is the number a buyer actually has in mind. F2 below
  asks only for a LABEL; it needs both.
- **PRICE IT AT $2.49/month, against TWO benchmarks — the ladder and the
  market.** Cost sets neither: 500 vCPU-minutes is 8.3 vCPU-hours, which at
  us-east-1 on-demand (~$0.036/hr Graviton, ~$0.045 x86, +~12% for EKS Auto
  Mode) is **$0.30–$0.47** of compute. Even as the one dimension with genuine
  marginal cost this is value-priced, and anyone reasoning from "real cost" to
  "expensive" has the wrong instinct.

  **Benchmark 1 — the ladder**, using the method the `seat` pack already uses:
  sit between the adjacent-step rates so upgrading stays better value. Per 500
  credits those steps imply Developer→Pro $3.25, **Pro→Team $1.33 (cheapest)**,
  Team→Business $2.36, **Business→Enterprise $4.33 (dearest)**. The binding
  requirement is that the pack must not undercut the CHEAPEST step after its
  deepest volume discount: at $2.49 the 30% break lands at **$1.74**, clearing
  $1.33 by 31%.

  **Benchmark 2 — the market, which an earlier draft of this bullet never
  checked and got wrong by 3.3x.** The two CI platforms customers already use
  both price Linux compute at **$0.003 per vCPU-minute**: CircleCI is a flat 5
  credits per vCPU-minute at $0.0006/credit (small 5, medium 10, large 20
  credits/min against 1, 2 and 4 vCPU), and GitHub Actions is $0.006/min for a
  2-core runner after its January 2026 cut. Market rate for 500 credits is
  therefore **$1.50**.

  That earlier draft priced the pack at $4.99 — **$0.00998/vCPU-minute, 3.3x
  market, and still 2.3x after the deepest discount** — because it derived the
  number from the ladder alone and called the top of the band the safe choice.
  It was internally coherent and externally indefensible. Note what the two
  benchmarks say together: the ladder's own cheapest step ($1.33) is already
  **market-consistent**, so a pack priced far above it is not protecting the
  ladder, it is overcharging against a rate the customer can look up.

  **$2.49 is ~1.7x market** — defensible as a platform premium on a product
  where builds are incidental rather than the thing being sold — and it keeps a
  comfortable margin over the ladder floor. $1.99 also clears the floor but by
  only 4.5%, which is too thin to be worth the extra dollar of discount.

  It is also coherently cheaper than the $11.99 siblings *because the grant is
  finer*. A smaller step costs less, which is what makes "enter 2000 credits"
  read as buying a quantity rather than a product.
- **Record the market rate beside the ladder rate, permanently.** The next
  repricing has to clear BOTH, and the $4.99 error happened precisely because
  only one of them was written down. `$0.003/vCPU-minute` is the number to beat
  or justify.
- **Do NOT inherit the annual discount.** `b()` defaults `annual` to
  `monthly x 10` — two months free, ~17% off, the catalogue's steepest standing
  discount. On a consumable with a supply ceiling, an annual pre-pay commits the
  platform to reserving capacity for twelve months at a discount, which is the
  opposite of what the ceiling wants. Set `annual` to `monthly x 12` ($59.88) and
  let the volume curve plus D11's batch class be the discounts on this
  dimension.

  Worth noting what the annual discount actually buys, because the comparables
  make it obvious: AWS and Anthropic both discount a COMMITMENT TO CONSUME,
  where this catalogue discounts PREPAYING A CAP. Prepayment buys cash flow;
  it does not buy demand predictability, which is the thing a Savings Plan buys
  AWS. The reasoning generalises beyond this pack.
- **And do NOT build a commitment discount, which is the obvious thing to copy
  from AWS and the wrong one.** Savings Plans exist because AWS provisions
  physical capacity years ahead and needs demand signal to do it. This
  platform's capacity is one sidecar that resizes in minutes for about
  $150/month (D9) — so a commitment discount would lock the platform into
  serving a baseline it would rather flex, buying predictability it does not
  need. The lever worth copying is latency tolerance (D11), not commitment.
- **`bundle-sizing` imposes NO price floor on this pack, and an earlier draft
  claimed otherwise.** `cpuCredits` still has to be added to both `DIMS` and
  `RATE_PACKS` — neither is derived from `VALID_QUOTA_TYPES` — but read what the
  test does with it: `closeGap` runs per dimension and the costs are SUMMED into
  one basket, compared once against the tier delta. Adding a dimension therefore
  makes `basket > delta` *easier*, and since the suite passes today without
  `cpuCredits` the property cannot be broken at any price.

  The "~$11.11 floor" (and the ~$13.34 before the daily rescale) came from
  treating the cpuCredits row as if it alone had to exceed the $40 Pro→Team
  delta. It does not, so the worry that $11.99 clears the floor by only 7% was
  about a constraint that does not exist. **The price is a margin decision, not
  a test-satisfying one** — which matters more here than elsewhere, because this
  is the one dimension the platform pays for per unit.
- **Register the Marketplace dimension.** `DEFAULT_BUNDLE_DIMENSION_MAP` must
  gain `cpu_credits_pack`, and a test holds the catalogue and the map in sync.
  The map's own comment records why: `stakeholder_reports` shipped missing from
  it and was therefore "granted to the customer and then NEVER metered on
  Marketplace, i.e. given away". Of every bundle to give away by omission, the
  only one with real marginal cost is the worst.
- **Decide about `throughput_bundle`.** It is `plugin_pack + api_pack + ai_pack`
  at $25.99 against a $35.97 member basket. CPU credits are *the*
  build-throughput dimension, so either they join it — repricing the combo, with
  `warnOnNonDiscountCombos` requiring it stay below the new basket — or the plan
  says why the throughput combo omits the throughput that costs money.
- **Say something about the annual price.** `b()` defaults `annual` to
  `monthly x 10`: two months free, ~17% off, the steepest standing discount in
  the catalogue. Inheriting it on the only dimension with per-unit cost should be
  a decision rather than a default.

**Why granularity was the decision behind all four.** Every add-on is
quantity x a fixed grant, so the grant size is simply the step the buyer types:
`seat` grants 1 and typing 8 means 8 seats; `storage_pack` grants 10 GB and is
typed in GB. Choosing a coarse grant is what put the earlier draft on the ratio
bound, made `CAPACITY_VOLUME` look right, and left the typed unit unstated. One
choice fixed three symptoms, which is usually the sign it was the real decision.

## Phase 3b — Every existing capacity pack now under-grants

Adding a dimension that is DERIVED from another one silently breaks the packs
that grant the other one. Under D12's flat column the formula is
`credits/month = builds x 45`, so:

| Pack | Grants | CPU credits it needs | Grants today |
|---|---|---|---|
| `plugin_pack` | +10 plugin builds / period = +100 / month | **4,500**/month | 0 |
| `pipeline_pack` | +5 pipelines, +25 plugins = +250 builds / month | **11,250**/month | 0 |

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

**Flat minutes are what make this expressible at all.** Under the ramped column
the same +10 builds needed 3,000 credits on Developer and 9,000 on Enterprise,
and neither the catalogue's flat grant object nor the scalar `_GRANT` override
can hold five numbers. D12 reduces it to one figure per pack.

**The `RATE_PACKS` conflict is smaller than an earlier revision claimed.** That
revision read the single-dimension rule as a constraint that FORCES `plugin_pack`
out of `RATE_PACKS`, giving up the ratio bound and the free-tier guard as
`pipeline_pack` already did. But `RATE_PACKS` is a **test-local constant** —
`api/billing/test/bundle-sizing.test.ts:62` — not production code. Nothing forces
a pack out of it; dropping one would be a choice to stop checking it. The rule
exists so "its ratio is unambiguous" (line 103), and the ratio bound is a
separate assertion (line 111), so **iterating dimensions restores both**: for
each dimension a pack grants, check that dimension's ratio against that
dimension's cap on every eligible tier. The free-tier guard (line 121) never
depended on dimension count at all and should apply to every capacity pack
unconditionally.

**The one real cost is the environment override.** `BILLING_BUNDLE_<ID>_GRANT`
parses a single integer, so a two-dimension grant needs a per-dimension key.
Rename it to `BILLING_BUNDLE_<ID>_GRANT_<DIMENSION>` outright — no alias, no dual
read — and update `bundle-docs-drift.test.ts` alongside the env docs.

**Sizing checks on the new grants:**

| Check | Figure | Result |
|---|---|---|
| `plugin_pack` credits vs lowest eligible cap | 4,500 of Pro's 11,250 | 40% — clears |
| `pipeline_pack` credits vs lowest eligible cap | 11,250 of Team's 22,500 | **exactly 50%** |
| `cpu_credits_pack` vs lowest eligible cap | 500 of Pro's 11,250 | 4.4% — clears |

`pipeline_pack` lands exactly ON the bound, passing only because the comparison
is strict — the same trap an earlier draft of the pack size fell into. Trim it,
or the row is fragile to any retune of Team. It is classed as a differentiator
and exempt from the bound today, but sitting on the bound is a smell rather than
a pass.

**And one combo changes value silently.** `throughput_bundle` contains
`plugin_pack`, so the +4,500 grant flows into it at today's $25.99. Both the new
pack and the reshaped `plugin_pack` grant need `DEFAULT_BUNDLE_DIMENSION_MAP`
entries in the same change — the map must list every bundle or its grants are
given away unpriced.

## Phase 3c — Capped, not metered. A decision, not an omission

CPU credits are the **first quota with genuine per-unit marginal cost**. Every
other dimension is a rate limit protecting shared infrastructure; this one is
compute the platform actually pays for. That invites a pricing model the plan
never weighs: meter it and bill overage, rather than cap it and sell packs.

Capped is still right, for a reason worth writing down rather than assuming:
there is **no overage-billing machinery in this codebase at all** (the storage
plan recorded the same thing — "there is no overage billing"). A cap plus packs
reuses the whole bundle apparatus; metering is a new subsystem with its own
invoicing, disputes and proration.

**But this is a sequencing decision, not a closed one — "capped by default,
opt-in overage later".** The comparison that settles it is Anthropic's own
split: the API is metered, while the *subscriptions* are capped with upgrade
paths. This product is the subscription side of that shape, and the subscription
side eventually needs a valve.

**Keep the cap, though, and treat it as a FEATURE.** The most-complained-about
property of both metered comparables is bill surprise — AWS has shipped whole
products (Budgets, Cost Anomaly Detection) to manage a problem its own pricing
model creates. The buyers here are engineering teams with fixed budgets and a
procurement process, and a platform that cannot surprise them is easier to buy.
The pool costs about $55/month (D9), so nothing about this pricing is
cost-constrained: the MODEL is the product decision, and predictability is the
part of it worth defending.

The real cost of capping is that the CUSTOMER bears stoppage risk, and for a
build system being stopped is worse than being billed — which is why the cap
needs escape hatches rather than a bare refusal: the grace band (D7), a pack
that takes effect within a minute (F-section), the batch class (D11), and
eventually opt-in overage.

## Phase 3d — The over-cap guard, and why credits need a different fix

`checkEntitlementOvercap` refuses a downgrade or pack removal that would strand
an account over a cap it cannot shrink into. It guards `seats`, `plugins`,
`pipelines`, `listings` and `storageBytes`, and excludes the per-period rate
quotas with a stated reason: *they reset, so landing over a reduced cap costs at
most one period.*

**The monthly window (D7) invalidates that reasoning for this dimension.** "At
most one period" is three days for `apiCalls` and **a month** for
`cpuCredits` — so a mid-month downgrade, or cancelling a CPU Credits Pack,
can refuse every build for the rest of the month. That is a month-long outage
caused by a billing click, which is precisely the failure the guard exists to
prevent.

The exclusion's REASONING has to be fixed either way, and that part is the same
correction storage needed: storage was grouped with the rate quotas on the "they
reset" rule, the rule did not apply to it, and the fix was one entry in that
list. The lesson generalises — **the exclusion is about period LENGTH, not about
being a rate** — and the guard's comment should say so, or the next long-window
quota repeats it.

**But the fix for credits is not another list entry.** Unlike `storageBytes`,
credits are spent continuously rather than held, so "current usage" against a
reduced cap is a point-in-time reading that keeps rising. A guard entry would
refuse the downgrade, which turns the month-long block from an accident into
policy: the customer is told they may not change plan until the window rolls.

**IMPLEMENTED.** `usage.<type>.limitAtPeriodStart` is captured in the same atomic
update that rolls the counter, and `computeQuotaStatus` takes
`max(snapshot, current)` with `-1` short-circuiting to unlimited on either side
(a `Math.max(-1, 100)` would silently cap an account holding an unlimited
entitlement). An expired window takes the current limit, which is how a reduction
eventually applies rather than never. Six tests cover it.

**The pooled counter carries it too**, and that half matters most: a root with
teams is the account most likely to buy and cancel packs, so protecting only the
per-org counter would have put the protection on the wrong one.
`pooledStatusFromRows` reads the pooled snapshot and `computeQuotaStatus` the
per-org one; both take the max and both short-circuit `-1`. The snapshot is
absent before the first pooled increment, which correctly falls back to the
current limit because no period is established yet.

**Resolved: capture the period's cap at its start.** Make a period's effective
cap `max(cap at period start, current cap)`, so caps only ever RISE mid-period. A
downgrade or a cancelled pack then applies from the next window, mid-period
upgrades still land immediately, and the guard's original reasoning holds intact
rather than needing an exception carved into it — landing over a reduced cap
again costs at most one period, because the reduction does not apply to the
period you are in. `cpuCredits` then needs no entry in
`checkEntitlementOvercap` at all; only the comment needs correcting.

Two notes on what this is not. It is **not** deferring the plan change itself to
the boundary: there is no scheduled or pending plan-change machinery in the
billing service — only Stripe's `current_period_end` reads and invoice periods —
so that would be a new subsystem rather than a wiring job. And it leaves a small
hole on purpose: an account can buy a pack, spend against it and cancel inside
one period. With no proration or overage machinery to exploit, the buyer has
still paid for the pack, so the hole costs far less than the outage it replaces.

## Phase 4 — Ingest CodeBuild

**STEPS 1 AND 2 ARE DONE. STEPS 3–4 ARE ONE PRODUCT EVENT AND NEED A DECISION,
NOT MORE CODE.** Step 1 shipped on its own merits — `pipeline_executions_total` now
carries `org_id`, so pipeline consumption is attributable per tenant by count.
Cardinality is bounded by the tenant count, which is the same bound
`cpu_credits_charged_total` and `quota_denied_total` already accept; `pipelineId`
stays off, because that one is unbounded per tenant.

**Why the rest stops here.** Step 3 re-derives every tier limit, and CHARGING
without step 3 is precisely the silent repricing step 3 exists to prevent: an
account's consumption jumps with no change in its behaviour. So the charge and
the re-derivation cannot ship apart, and together they are a change to the
published ladder and to every pack grant D12 and Phase 3b derived — a priced,
announced change rather than an implementation task.

**And step 3 cannot be derived until the series has run.** That is why step 2 is
scoped to MEASUREMENT: the consumption is now observed and attributed per org and
per compute size, and charged to nothing. The denominator is accumulating; what
is missing is a month of it, plus the coverage ratio that says how much of it is
real.

**The sequencing that follows from this**, and it mirrors the one open item 8
already accepts for the wait promise:

1. **DONE** — `org_id` on `pipeline_executions_total`.
2. **MEASURE, do not charge. DONE — and it needed none of the infrastructure
   this step assumed.** The claim that nothing observes completion was wrong
   about the codebase: it is true of the pipeline SERVICE (which only starts and
   stops executions) and false of the platform, because
   `packages/pipeline-events` is already an in-account EventBridge forwarder
   posting to `/reporting/ingest` with `eventType: 'ACTION'`, `durationMs`,
   `startedAt`/`completedAt` and the `pb.pipeline-id` tag that joins to the org.
   It already holds `codebuild:BatchGetBuilds`. No poller, no leader lock, no new
   IAM.

   What was actually missing was the multiplier and the sink:

   - `CODEBUILD_COMPUTE_VCPU` + `computeCreditsFor` in api-core, beside the
     `ComputeType` whose doc comment already carried the same vCPU figures;
   - the forwarder reading `environment.computeType` off the finished build and
     promoting it as a typed field (its own field rather than a `detail` key, for
     the reason `failure` has one: `detail` is bounded at 8 KB and already sheds
     content under that bound);
   - `pipeline_compute_credits_total{org_id, compute_type}` and
     `pipeline_compute_actions_total{org_id, compute_type, measured}` fanned out
     of `emitIngestMetrics`.

   **Fanned off the INSERTED rows, which is load-bearing here in a way it was not
   for the stage metrics.** A duplicated stage outcome distorts a rate; a
   duplicated vCPU-minute figure is a double-charge waiting for the day the
   charge is switched on. The dedup index is what prevents it.

   **The compute size is read from AWS, not from our stored config.** The config
   holds a step's REQUESTED size; what it actually ran on is what consumed vCPU,
   and a pipeline edited between start and finish would otherwise be priced
   against the new value. An unreadable size returns `null` and the action is
   recorded as unmeasured — never guessed as `SMALL`, which is the cheapest and
   therefore the most flattering guess.
3. **Run a month, then re-derive the ladder from the observed distribution** —
   not from an estimate. A ladder derived from data survives its first bad month;
   one picked from a model gets quietly re-cut.

   **Read the coverage panel first, and this is a hard prerequisite rather than a
   caution.** The forwarder refuses to compute a duration unless AWS declared a
   `start-time` — it used to fall back to the event time, which reported every
   terminal stage as 0 ms and dragged every average and p95 toward zero with
   nothing saying anything was missing. So a real fraction of actions arrive
   unmeasurable, `measured="false"` counts them, and the coverage ratio has its
   own panel sitting above the credits one. A ladder priced off the credits series
   before that ratio is known is a ladder priced off an unknown denominator.
4. **Flip the charge on and change the scope sentence in the same release**,
   which is the communication story D1 bought by stating the scope rather than
   encoding it.

Until then the quota is narrowly scoped and the product copy says so, which is a
coherent state rather than a half-built one.

The original steps, kept because other sections cite them by number:

1. add `org_id` to `pipeline_executions_total` — one label, and executions become
   attributable by count even before any of this;
2. charge CodeBuild duration × its compute class into the same quota;
3. **re-derive every tier**, because the denominator has changed: an account's
   consumption jumps with no change in its behaviour, and leaving the ladder
   alone would be a silent repricing.
4. **change the scope sentence**, which is the whole communication story D1
   bought by stating the scope rather than encoding it: "Pipeline executions run
   in AWS and are not counted yet" becomes "Pipeline executions are counted
   too". The tier resize in step 3 is the moment customers hear about it.

Until then the quota is narrowly scoped and says so.

## What is settled, and what is still open

**Settled.** The two questions this plan originally left open — the three-day
period (Q3) and a separate budget for automated builds (Q5) — are decided in
**D7** and **D8**. Each was resolved by checking the code rather than by picking
a side: Q3 turned on finding that the invariant meant to make it harmless is
false and that a per-type period is far cheaper than assumed; Q5 turned on
finding that the surface being protected is not analogous and that the job
payload carries no principal to split on.

**Still open.** An earlier revision of this section claimed only one judgement
remained, which stopped being true as the plan grew. The list below is grouped by
when each item has to be answered, with **four now closed in place** — items 4,
6 and 10 by D12 and the Phase 3 / 3b derivations, and Phase 3d's guard question
by the period-start rule. Numbering is kept stable because other sections cite
these by number.

*Before Phase 1 ships, because they set contracts:*

1. ~~**The window mechanism (D7).**~~ **DECIDED: a rolling 30-day window**, via
   `quotaPeriodDays(type)` and `QUOTA_CPU_CREDITS_PERIOD_DAYS` (default 30).
   Rolling needs no new mechanism — `nextQuotaResetDate` already does day
   arithmetic with a lazy per-org reset — while calendar-month alignment needs a
   different reset shape AND a subscription-anniversary lookup the quota service
   does not have. The one thing calendar alignment buys is an invoice whose period
   matches the usage period, which matters only if overage is ever billed, and
   Phase 3c says it is not. Revisit it with overage, not before.
2. ~~**Provisioning (D9).**~~ **DECIDED, in two halves, because they are not the
   same decision.** Raise `requests.cpu` to `1500m` NOW: it buys no hardware (the
   node is already paid for) and it is a correctness fix, because selling 1.5 vCPU
   of throughput against a 0.3 vCPU reservation promises what the scheduler never
   set aside. Buy the second replica — one `c7g.large`, about $59/month, covering
   the flattened top tier's 1.56 vCPU — WHEN THE FIRST BUSINESS ACCOUNT LANDS, not
   before. Pre-buying capacity for a tenant that does not exist is the one part of
   this that can wait, and the commitment gauge is what says when it cannot.
3. ~~**`SINGLE_TENANT_SHARE` (D9).**~~ **DECIDED: 1.0, not the 0.5 this plan
   argued for.** Half is a FAIRNESS bound, and the invariant that actually matters
   is DELIVERABILITY: a tier's cap must be reachable by that tenant alone on an
   otherwise-idle platform. At 0.5 the published ladder would have to be halved,
   which no comparable platform does — GitHub and CircleCI both publish caps a
   single customer can reach. Bound concurrent tenants with the per-tier worker
   concurrency instead (item 13): that is a rate limit tunable without touching
   the price list, where `SINGLE_TENANT_SHARE` is a haircut on the thing being
   sold.

*Product judgements, answerable now but not by reading code:*

4. ~~**The wall-minutes column (Phase 1).**~~ **CLOSED by D12** — flattened to 30
   on every tier. The ramp double-counted tier and attributed to the payer what
   belongs to the project, and flattening also made the Phase 3b pack grants
   expressible as one figure each.
5. ~~**The per-build ceiling N (D5).**~~ **CLOSED WITHOUT BUILDING IT — a tighter
   ceiling is already enforced.** `DOCKER_BUILD_TIMEOUT_MS` (900s) plus
   `SUPPLY_CHAIN_STEPS` x `DOCKER_PUSH_TIMEOUT_MS` (2 x 300s) bounds a build at
   25 minutes of wall clock, which at 1.5 vCPU is 38 credits — well inside the
   decision below and already load-bearing for the F3 closure's overshoot bound.
   A second ceiling expressed in credits would be a second thing to keep in sync
   with the first. The original decision, for the reasoning: **60 minutes.** At 1.5 vCPU
   that is 90 credits against Developer's 4,500 — 2% of the smallest budget, so
   the ceiling can never make a tier unusable, which was the constraint. It is
   high enough that no honest build hits it and low enough that one runaway
   Dockerfile cannot eat a month.
6. ~~**`maxQuantity` on the pack (Phase 3).**~~ **CLOSED at 22** — and it was
   never downstream of D9. Pro's no-crossing bound, `(22,500 - 11,250) / 500`,
   binds before the supply bound of 124 does, so the cap is decidable today.
   Phase 3 carries the derivation and the cannibalisation check.
7. ~~**Whether the pack joins `throughput_bundle` (Phase 3).**~~ **DECIDED: no,
   and the reason is now concrete.** The combo ALREADY gained 4,500 credits
   silently, because it contains `plugin_pack` and Phase 3b gave that pack its
   minutes. Adding the credits pack on top would make a $25.99 combo the cheapest
   route to credits in the catalogue and undercut the $2.99 pack inside it —
   which is the combo-beats-its-own-member shape the bundle-sizing test exists to
   catch.
8. **The batch class's discount and its wait promise (D11).** **DECIDED on the
   discount: ship the class with NO multiplier.** D12 derives credits from the
   `plugins` cap, so the two bind simultaneously at 1x by construction — any
   multiplier below 1x leaves `plugins` the only cap that bites, which makes a
   batch discount inert for exactly the high-volume customer it was meant to
   attract. The PRIORITY is the product; the price is not. **DECIDED on the wait promise: promise nothing yet.** It cannot
   honestly be bounded today, and not only because the capacity floor (item 14) is
   missing — `plugin_job_wait_seconds` is recorded ONLY for jobs that got a slot,
   so a starved job contributes nothing to the very metric the promise would be
   set from. Label that histogram by class with D11, run a month, then publish the
   **observed p99 rounded up to a round number** rather than a target. A promise
   derived from data survives its first bad week; one picked as a marketing figure
   gets quietly dropped, and a dropped promise is worse than never having made
   one. Originally two
   questions, not one. The CLASS needs no price and must not wait on one. The
   MULTIPLIER is near-inert, because D12 makes credits and `plugins` bind
   together, so it discounts SLOW BUILDS rather than volume — Claude's 50% is
   still the anchor, but price it as what it is. The wait promise is the hard
   half: it cannot be bounded at all until a floor of buildkitd capacity is
   reserved for the standard class, and a bound nobody enforces is not a
   promise.
9. **Whether to sell a FASTER class at all (D11's twin).** Both CI competitors
   monetise resource classes and this plan cannot express one, because
   `buildkit_vcpu` is global AND buildkitd is a sidecar of the plugin pod behind
   a per-pod `BUILDKIT_HOST`. Building it means per-build allocation, which
   changes D2's shared-sidecar premise and D9's supply arithmetic — so it is a
   real decision, not a parameter. **CLOSED as a question by D13:** the answer is
   yes, because a credit is a vCPU-minute, which makes a resource class
   credit-neutral per build and so free to price. What is left is the tier gates
   (item 15), not the decision. **And it was never independent:** decoupling
   buildkitd into its own runner is a prerequisite it SHARES with D9's supply ramp
   and D11's reserved standard-class floor, so sequence that infrastructure once
   for all three. **RECOMMENDED SEQUENCING: do this LAST.** It is the only
   remaining item gated on infrastructure rather than on a number, and the
   decoupling it needs is the same one item 2's second replica and item 14's floor
   need. Doing it last means doing that work once.
10. ~~**The `RATE_PACKS` single-dimension conflict (Phase 3b).**~~ **CLOSED** —
   the premise was wrong. `RATE_PACKS` is a test-local constant
   (`bundle-sizing.test.ts:62`), not production code, so nothing forces a pack out
   of it. Reshape the ratio assertion to iterate dimensions and the bound and the
   free-tier guard both survive; the only real cost is renaming
   `BILLING_BUNDLE_<ID>_GRANT` to a per-dimension key.

*Measurements, not decisions — they resolve themselves once Phase 2 runs:*

11. **NOW MEASURABLE — do not decide it, instrument it.**
    `cpu_credits_charged_total{org_id, outcome}` ships with Phase 2, so this
    resolves from data after one month of real traffic. **Recommendation: do not
    publish the tier table to customers until that month has run**, because every
    number in it rests on this one. Original framing: the one number here with
    no
   evidence behind it. `cpu_credits_charged_total` per org against the tier cap
   gives real utilisation after a month, and the ladder should be re-derived from
   that rather than from a guess.
12. **RECOMMENDED: suppress the forecast until 20% of the period has elapsed**,
    and let the data tighten it. That is about 6 hours on the three-day window and
    6 days on credits' monthly one. The figure is arbitrary, which is acceptable
    because it errs in the conservative direction: a suppressed forecast shows
    nothing, while an early one extrapolates a single build into a breach
    prediction and the monthly window makes that error ten times larger. Revisit
    from the same month of data that resolves item 11. Original framing: it needs
    a minimum-elapsed guard before the monthly window leans on it; how long is an
    empirical question once there is data.

*Answerable now, and cheaper than the things they unblock:*

13. **HALF DONE, half BLOCKED — and the blocked half is not a missing decision.**
    The per-tier WORKER concurrency is implemented at 1 · 2 · 2 · 3 · 4 (it is
    what makes `SINGLE_TENANT_SHARE` 1.0 safe, since each tier's Worker bounds
    that tier's concurrent builds across every org). The per-org STANDARD/BATCH
    split cannot exist until D11 does: there is no `class` field on a build to
    split a semaphore on, so this is blocked on code rather than awaiting a call.
    When D11 lands, use 1/3 · 2/4 · 3/6 · 5/10 · 8/16. **DONE — that is exactly
    what `TIER_BUILD_SLOTS` carries, and `PLUGIN_MAX_BUILDS_PER_ORG` no longer
    exists.**

    **One interaction the implementation surfaced:** with worker concurrency above
    1, `PLUGIN_MAX_BUILDS_PER_ORG` finally BINDS. At the old flat default of 1 an
    org could never reach a cap of 3, so the per-org semaphore was unreachable and
    every slot behaviour built around it was dead code. Original recommendation —
    standard/batch per org of
    1/3 · 2/4 · 3/6 · 5/10 · 8/16, and per-tier worker concurrency of
    1 · 2 · 2 · 3 · 4.** Deferred headroom exceeds standard on every row (so the
    cheap class is where the room is) and the worker ladder is what bounds the
    aggregate, which is what lets item 3 be 1.0. Both knobs are already built and
    both are flat today, so this is configuration, not code. Original framing:
    the per-tier standard/batch slot mix, and the per-tier worker
    concurrencies (D11).** Two knobs, both built and both untuned:
    `PLUGIN_MAX_BUILDS_PER_ORG` is 3 for every tier (D11 splits it into a standard
    and a batch figure per tier), and all six
    `PLUGIN_BUILD_CONCURRENCY_<TIER>` values default to the same global number,
    which leaves the platform-wide free-tier bound unset. The shapes are settled;
    only the numbers are a judgement, and they wait on nothing — not D9, not the
    class work, not the multiplier. The per-tier concurrency in particular is what
    bounds the free aggregate, so choose it BEFORE the pool is sized, not after.
15. **RECOMMENDED: ship the GATE, withhold the RECOMMENDATION.** `2x` from Team
    and `4x` from Business as the entitlement — but suggest a size to nobody until
    there is per-plugin speedup data. The gate is a capability and the suggestion
    is a claim; only one of them needs evidence, and a 4x charge on an I/O-bound
    build that gains nothing is the complaint that sticks. Original framing:
    `2x` from Team, `4x` from Business — but gate the ADVERT on
    measured speedup, not just the tier.** A 4x charge for an I/O-bound build that
    gains nothing is the complaint that sticks, and D13 already requires
    per-plugin speedup data before recommending a size. Ship the gate; withhold
    the recommendation until the data exists. Original framing: which tiers may
    request `2x` and
    `4x`. The pricing needs no decision — credits already charge vCPU-minutes, so
    a size is credit-neutral per build — so this is purely a capability gate, of
    the same shape as `idpConfigs`. Downstream of the buildkitd decoupling, and
    of per-plugin speedup data: gate on what a size actually delivers, not on
    what it sounds like it delivers.
14. **ANSWER IT WITH ITEM 2 — it is the same reservation question.** Until
    buildkitd is decoupled from the plugin Deployment there is nothing to reserve
    a fraction OF, so the floor is downstream of the provisioning decision rather
    than beside it. Original framing: reserving a
    fraction of buildkitd for non-batch builds is what makes the wait promise
    computable and what makes "batch yields to paid" true at the resource. It
    is the same reservation question as D9's `requests`, so answer both together
    rather than letting the queue layer imply a guarantee it cannot keep.

### The sequencing these share

**Four of the five remaining items want the same month of real traffic, and three
want the same piece of infrastructure.** Deciding them separately means deciding
each one twice:

- **One month of data** resolves item 11 (the utilisation assumption behind the
  whole ladder), item 12's forecast guard, item 8's wait promise, and item 15's
  speedup claims. `cpu_credits_charged_total` and the class-labelled wait
  histogram are what produce it.
- **One piece of infrastructure** — decoupling buildkitd from the plugin
  Deployment — serves item 2's second replica, item 14's standard-class floor and
  item 9's faster class.

So: ship D11 and D13's gate, let a month run, then set the wait promise, the
forecast guard and the re-derived ladder together from one dataset. The
alternative is three separate guesses, each of which looks defensible on its own
and none of which can be checked against the others.

## Checked and NOT a gap: the seat pack

`seat` carries a per-seat capacity invariant — every paid tier holds exactly
100,000 API calls and 200 AI calls per seat, and the pack grants that share so a
bought seat is worth a tier seat. The obvious question is whether it must now
grant CPU credits too.

It must not, because there is no invariant to preserve: per-seat minutes are
**not** constant across the ladder — Pro 11,250, Team 7,500, Business 5,625,
Enterprise 4,500. Recorded so nobody re-raises it.

Worth noticing while here, though: **D12 removed the coincidence that made a
change here look attractive.** Under the ramped ladder Pro and Enterprise both
landed on exactly 9,000 per seat, so re-deriving only Team and Business would
have made the column constant and brought the dimension under the existing
invariant test for free. Flattening replaces that with a monotonic decline,
because seats grow faster up the ladder than builds do. A constant column would
now mean re-deriving every row above Pro, and at 11,250 per seat Enterprise would
need 168,750/month — far beyond anything D9 can supply. So this stays a
recorded non-gap rather than a deferred improvement.

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

An earlier draft called this work "free" twice and was wrong twice. A later
revision corrected that and then undercounted it differently: it costed five
deliverables against the display catalog and missed two changes that are
STRUCTURAL rather than additive, one deliverable that would undo D1, and the
whole of D11.

**F0 — IMPLEMENTED.** `periodDays` is on `QuotaSummary` (optional, not required
— the org-level field remains for the page-wide default and `QuotaCard` takes
`quota.periodDays ?? periodDays`, so a response from an older deployment renders
the org window rather than nothing). `periodLabel` says "monthly" and
`periodPhrase` "this month's limit" for a 28–31 day window, and `QuotaPressure`
carries the per-quota value so the banner describes the window it is actually
warning about. The pooled path threads it through the shared `periodDaysForType`
helper, so a pooled org gets the same window as a standalone one.

**F0 — the original analysis, kept for the reasoning. `periodDays` has to move
from the ORG to the QUOTA, and that is a shape change.** An earlier revision recorded this as "D7 moves `periodDays` into
`QuotaSummary`", which undersells it. The field sits on `OrgQuotaResponse`
(`frontend/src/types/organization.ts:160`) and its own comment states the
invariant D7 breaks:

> *Length of the usage period in days (`QUOTA_RESET_DAYS`, default 3). Every
> counter rolls over on this one period — never assume a month. The usage
> forecast needs it and is simply not shown without it.*

`QuotaSummary` is `{ limit, used, remaining, unlimited, resetAt }` and carries no
period at all, so there is nowhere for a monthly credits window to live. Three
consumers compute MEANING from the org-level value, and each is wrong for credits
the moment D7 lands:

- **`QuotaBanner` would describe the wrong window.** `periodPhrase` renders
  "this 3-day period's limit", and `highestPressure` iterates EVERY quota on the
  response — so credits can become the banner's headline and be described with
  a three-day period.
- **`UsageForecast` would extrapolate to the wrong boundary.** `QuotaCard` gates
  it on `!isStock && periodDays`; credits are flow, so it renders, against a
  boundary ten times too near. **D7 leans on the forecast as its main safety
  mechanism, so this is D7's period change breaking D7's own safety mechanism.**
- **`QuotaCard`'s "Edit limit" names no window**, which is harmless while every
  quota shares one and misleading the moment the card above it says three days
  while the field edits a month.

So: add `periodDays` to `QuotaSummary` as REQUIRED, delete the org-level field
rather than keeping both (no dual path), and thread it from the summary at each of
the six call sites plus the generated `api-reference.ts`. Name the window in the
forecast and in the edit affordance while there, because the page now mixes them.

**F0b — `cpuCredits` must join `DISPLAYED_QUOTA_TYPES`, and this one has already
shipped as a bug once.** The quotas page renders a curated six-member subset
(`plugins`, `pipelines`, `apiCalls`, `automationCalls`, `aiCalls`,
`storageBytes`) declared `satisfies readonly QuotaType[]`. A quota absent from it
is simply not drawn — and the list's own comment records the consequence,
because `storageBytes` used to be missing:

> *The app-wide `QuotaBanner` already warns about storage on every dashboard page
> … so an org at 85% storage was warned everywhere and then clicked through to the
> one page dedicated to limits, where the dimension was missing.*

Credits reproduce that exactly. Add the entry in the SAME commit as the catalog
entry, with a test pinning the two in sync.

**F1 — DROPPED. A `minutes` render mode would undo D1.** An earlier revision
proposed adding `'minutes'` to `QuotaRender` and formatting credits as "2h 30m",
costing it as one compiler-enforced entry. The costing was right and the
deliverable is wrong: D1's whole argument for the rename is that **"11,250 build
minutes" reads as 187 hours when it buys 125, and an abstract unit cannot be
misread as wall-clock.** Rendering the abstract unit as a duration converts it
straight back into a wall-clock-looking figure.

So `QuotaRender` stays `'count' | 'bytes'`, credits render as `11,250`, and the
duration conversion moves into F5's hint, where it explains rather than
misleads. **The exhaustive switch needs no new case at all** — cheaper than the
revision that proposed extending it.

**F2 — IMPLEMENTED.** `packUnit: { name: 'credits', per: 1 }` is on the catalog
entry, so `AddonGrid` reads "500 credits" and `QuotaCard`'s admin edit field
converts through an identity. The original note follows.

**F2 — a `packUnit` on the catalog entry.** Unchanged in substance: the unit is
`packUnit` on the catalog entry, `AddonGrid` reads it through `quotaPackUnit`, and
a +500/month pack reading "500 credits" says far more than "1 pack". One
correction — `packUnit` is load-bearing in TWO places, not one: `QuotaCard`'s
admin edit field also converts through it (`toDisplay` / `toRaw`), so
`{ name: 'credits', per: 1 }` makes that conversion an identity and has to be
declared rather than omitted.

**F3 — CLOSED, and D3 with it. Building the reservation would CREATE the problem
F3 exists to solve.**

Two findings reversed this, both from the code rather than from the note below.

**First, D3 is cheap — and that is the argument against it, not for it.**
`withQuotaReservation` already takes an `amount` and already refunds that same
amount against a period-safe `resetAt` snapshot, so "reserve an estimate" needs
no new mechanism. But a build's cost is not known until it has run, so the
reservation has to book the CEILING; `used` then jumps by a whole build's worth
and drops back on settle. That is precisely the usage-goes-backwards state F3 was
written to paper over. Build D3 and you owe F3; skip it and F3 has nothing to
render.

**Second, the exposure it would prevent is already bounded — and the bound is
tighter than this plan assumed.** It is the per-org slot caps (D11) multiplied by
the per-build wall-clock bound, and that bound already exists:
`DOCKER_BUILD_TIMEOUT_MS` (900s) plus `SUPPLY_CHAIN_STEPS` x
`DOCKER_PUSH_TIMEOUT_MS` (2 x 300s) = 25 minutes, which at 1.5 vCPU is 38
credits:

| Tier | Max in flight | Largest machine | Worst-case overshoot | Of a period |
|---|---|---|---|---|
| developer | 4 | Standard | 152 | 3.4% |
| pro | 6 | Standard | 228 | 2.0% |
| team | 9 | Medium | 684 | 3.0% |
| business | 15 | Large | 2,250 | 5.0% |
| enterprise | 24 | X-Large | 7,200 | **10.7%** |

Only reachable by an org saturating every slot simultaneously at the cap, and
always in the tenant's favour. **`Small` cannot raise any row**, because the
deadline scales by the inverse of the multiplier and the charge by the
multiplier, so its per-build ceiling equals Standard's exactly.

**X-Large doubles the top row, and that is worth saying rather than burying.**
Enterprise goes from ~5.3% to ~10.7% purely because an 8x machine can burn 300
credits inside one deadline. Still bounded, still in the tenant's favour, and
Enterprise has the largest absolute budget — but it is the row where headroom
admission (below) would earn its keep first, and the row to watch on the
overshoot series. **This also closes open item 5 (D5's
per-build ceiling) without building it**: the existing timeouts already enforce a
tighter ceiling than D5's proposed 60 minutes, and the largest-size column is
what makes the bound worth watching rather than the duration.

**So it is MEASURED rather than prevented.** `incrementMetered` already returns
`{ counted, overshoot }` and every overshoot already lands as a per-org
`usage_events` row carrying its route, principal and build class — the
drill-down existed; what was missing was a series an alert could see. Added:
`quota_overshoot_total{type}`, a `CpuCreditOvershoot` rule that fires when the
whole worst case is being spent every hour (i.e. admission has stopped binding),
and a panel saying plainly that a trickle is expected.

**If it ever stops being small, the cheap fix is not D3 either.** It is HEADROOM
ADMISSION — refuse when `remaining < (inFlight + 1) x ceiling`, reading the
in-flight count from the per-class slot counters the route can already reach.
No reservation state, no settle, and no number that moves backwards.

The original note follows, because it is what D3 would have to satisfy if the
data ever justifies it.

**F3 — show in-flight reservations, or the number appears to go backwards.** D3
reserves an estimate at admission and settles on completion, so while a build
runs `used` includes a reservation that may be REFUNDED. The page will show usage
climb and then drop, and no quota does that today — AI reservations settle in
seconds, builds in minutes. Either show "N in flight" explicitly or render the
reserved portion distinctly from the settled portion. **A requirement on D3, not
a nicety.** D11 adds a second kind of in-flight, so the affordance carries the
class.

**F4 — IMPLEMENTED for the three refusals that exist; the fourth has no code
path to disposition.** Where each one now speaks from:

| Refusal | Said by | Remedy it states |
|---|---|---|
| Monthly budget exhausted | `BuildCostHint` before submit, then the 429's `quota-exceeded` window event → `QuotaBanner` | buy a pack, or wait for the window |
| Per-build ceiling (D5) | **nothing — D5 is not built.** No ceiling is enforced, so a disposition for it would be dead code pretending to be one | — |
| At the per-org slot cap | the slot gate's SSE `WARN` on the first delay, naming the class and its own cap | wait; explicitly "nothing to buy or fix" |
| Wait budget exhausted | `buildFailureInfo` → `BUILD_SLOT_TIMEOUT` | wait, or switch class — and it names the OTHER class |

The slot refusals are recognised from the terminal event's typed details
(`maxBuildsPerOrg`, `buildClass`), never from its prose, so an unrelated 503 — a
registry timeout is also `SERVICE_UNAVAILABLE` — does not take that branch.

**F4 — FOUR refusals, not two.** An earlier revision counted two. The real set,
and what each one's remedy actually is:

| Refusal | What fixes it |
|---|---|
| Monthly budget exhausted | buy a pack, or wait for the window |
| This single build exceeds the per-build ceiling (D5) | fix the build — a pack cannot help |
| At the per-org concurrent-slot cap | **wait** — nothing to buy, nothing to fix |
| Batch queue saturated (D11) | wait, or run it in the standard class |

Two of the four are waits rather than purchases, and two cannot be resolved by
buying anything. One shared 429 sends all four to the billing page.

**F4b — the slot-blocked state is SILENT today, and credits will be blamed for
it.** A pre-existing gap rather than new work, and it is the third row above:
`tryAcquireOrgSlot` failing calls `moveToDelayed(ORG_SLOT_DELAY_MS)` and throws
`DelayedError`, so the build sits in "queued" with no reason given and no SSE
event explaining it. Today a user guesses; once a credit budget sits on the same
page they will guess "quota", and the support traffic lands on this plan. **Worth
fixing on its own merits, independent of everything else here** — it is the one
item in this section that needs none of the rest of the plan.

**F5 — IMPLEMENTED as `BuildCostHint`, on all three build surfaces** (upload,
AI builder, wizard). It renders "About 15 credits — roughly a 10-minute build at
1.5 vCPU — against 3,500 remaining this month", scales with the machine size, and
the submit control is disabled on the SAME predicate the hint refuses from
(`buildCreditsBlocked`), so the control and the explanation cannot disagree.

Two things came out differently from this note. `useAIQuota` was GENERALISED into
`useOwnQuota(type, busy)` rather than copied: the fail-open-to-null rule is the
load-bearing part of both, and two copies of a fail-open path is how one of them
ends up failing closed and locking a control the server would have served. And
the vCPU figure is STATED in the line rather than read from config — it is a
plugin-service env var the frontend has no way to see, so an operator who raises
it would otherwise make the line quietly wrong; `frontend/test/build-shape.test.ts`
fails if the plugin service's default moves away from 1.5.

**F5 — a cost hint before the build, modelled on `AIQuotaHint`.** Unchanged, and
now the home for the unit conversion F1 was going to put in the wrong place:
"about 15 credits — roughly a 10-minute build at 1.5 vCPU — against 2,900
remaining this month". Reuse `formatDuration` from `frontend/src/lib/format.ts`
for the wall-clock half rather than starting a second duration vocabulary; that
file's own comment records the app having had three of these and consolidating
them. `AIQuotaHint` already handles the not-charged case, disables the action on
the same predicate the caller uses, and fails open when the quota cannot be read.
**Highest-value item in this set.**

**F6 — IMPLEMENTED, except the queue-position state.** What shipped:

- a class choice at submission (`BuildShapeFields`) on all three build surfaces,
  ungated on every tier — gating the cheaper class would be charging for the
  thing that smooths load;
- the class and size on the SSE `Build started` event, and on
  `plugin_job_wait_seconds`, `plugin_build_slot_denied_total`,
  `plugin_build_slot_timeout_total`, `plugin_build_slot_reclaimed_total` and
  `cpu_credits_charged_total`, plus the credit ledger's `feature`
  (`build:user:batch:4x`);
- the per-tier standard and batch counts on the picker's hint and in a
  `BuildCapacityCard` beside the quota cards — capacity is not a quota and does
  not belong on a quota card, since a slot is occupied and given back rather
  than spent;
- the machine sizes rendered WITH their gates (`2x · Team and above`), gated
  sizes shown-and-locked in both the picker and the capacity card.

**"Queued as batch, N ahead of you" is NOT built, and the reason is that the
number cannot be computed honestly.** BullMQ has no queue-position primitive, and
the figure would have to be invented from a waiting count that mixes every org on
the tier. A wait state that quotes a number nobody can reconcile is worse than
one that says what it knows, so the `WARN` says the class, the class's own cap and
the retry interval instead. The honest version of this needs the observed-p99
promise from open item 8, which needs a month of the now class-labelled
histogram.

**A per-plugin DEFAULT size was also not built.** The size is per submission,
which is where the request is; a remembered per-plugin default is a schema column
on the plugin row and a second place for the tier gate to be enforced (a plugin
whose stored `4x` outlives a downgrade), so it waits for a reason to exist.

**F6 — the build class, which an earlier revision omitted entirely.** D11 is a
graded per-tier dimension now, and nothing in the frontend expresses it:

- a class choice at submission, or a per-plugin default;
- the class shown in build history and in the SSE build stream;
- the per-tier standard and batch slot counts surfaced where the other per-tier
  caps already are;
- a "queued as batch, N ahead of you" state — the batch class's entire
  user-visible promise, and something the app has no precedent for;
- the machine sizes rendered WITH their gates (`2x · Team and above`), gated
  sizes shown-and-locked rather than hidden, and an "available sizes" row in the
  tier matrix (D13). This is where the tier relationship becomes visible, so it
  is the part that makes the size ladder legible as a reason to upgrade.

**Post-purchase latency is bounded, and worth saying (Q6).** A denied check
reading is cached until the period resets, capped at
`QUOTA_CHECK_DENIED_CACHE_MS` (60 s), explicitly "so an upgrade, a bundle or an
operator reset is honoured within a minute". So an org that buys a pack to
unblock a build may wait up to a minute. Deliberate and bounded, not a defect —
but the purchase confirmation should say so, or it will be reported as one.

### Docs

A CPU-credits section in `docs/quotas.md`: the unit and how it is derived, the
per-tier table, that **failed builds are charged** (and which retries are not),
the per-build ceiling, and what the pack buys.

## How we would know it worked

- **Does the charge match reality?** `cpu_credits_charged_total` summed per org
  should track `plugin_build_duration_seconds{org_id}` × the vCPU figure. Drift
  means the accounting is wrong, and this is the check that catches it.
- **Does it bind before the count quota?** If `cpuCredits` refusals outnumber
  `plugins` refusals on any tier, that tier's per-build allowance in the derived
  table is too low — this quota is meant to catch pathological duration, not
  normal use. Watch Developer first: it is the tier where the two are closest.
- **Does anyone buy the pack?** If orgs hit the cap and churn rather than buying,
  either the cap is too low or the pack is priced wrong.

## Rough sizing

| Phase | Size | Why |
|---|---|---|
| 1 | Small–Medium | A union member plus compiler-named tables; D7 adds a per-type period (a lookup threaded to two call sites) and moves `periodDays` into `QuotaSummary`, which touches the dashboard. D10's utilisation figure is a guess until Phase 2 measures it |
| Frontend | Medium | F1 is DROPPED (it would undo D1) and F2 is a catalog field, but F0 is a shape change moving `periodDays` from the org onto `QuotaSummary`, threaded through six call sites plus generated help; F0b is a one-line list entry that ships as an invisible-quota bug if missed; F4 is four refusal messages rather than two; and F6 (the build class) was omitted entirely. F4b is independent of the whole plan and fixable now |
| 2 | Medium | Two metering hooks, a reserve-and-true-up settle shared with the `plugins` gate, retry pricing, exemptions, ledger attribution |
| 3 | Small–Medium | One catalogue entry, two test-list additions, a Marketplace dimension, and `maxQuantity: 22` — derived in Phase 3 and no longer blocked on D9 |
| 3b | Small–Medium | Extending `plugin_pack` / `pipeline_pack` grants, the minutes-per-build ratio test, reshaping the `bundle-sizing` ratio assertion to iterate dimensions, the `_GRANT_<DIMENSION>` env rename, and a `DEFAULT_BUNDLE_DIMENSION_MAP` entry so `throughput_bundle` does not ship the grant unpriced |
| 3d | Hours | Capture the period's cap at its start — one rule in the effective-cap read — plus the guard comment recording that the exclusion is about period LENGTH |
| D11 | Medium | Larger than an earlier revision assumed, which costed it as a job priority BullMQ already supports. Actually: a class field on `PluginBuildJobData`, per-class admission inside the worker (NOT a BullMQ priority — six per-tier queues make an in-queue priority meaningless), a tier-aware per-org slot cap, dequeue-time quota reservation for batch jobs, a reserved standard-class capacity floor, a per-tier standard/batch slot mix (every tier gets both classes), a `class` label on the meter and ledger, and the copy that makes the wait a promise |
| D13 | Small, AFTER the prerequisite | A size field on the job, the per-build vCPU passed to buildkitd, and a tier gate. No pricing work at all: credits already meter vCPU-minutes, so a size is credit-neutral per build. The per-plugin speedup measurement is the real content |
| D11 prerequisite | Medium | Decoupling buildkitd from the plugin Deployment into its own runner. Shared with D9's supply ramp and with any faster class (item 9), so it is one piece of work, not three |
| 4 | **Largest** | A new AWS ingestion path, plus re-deriving every tier against the widened denominator — but NO rename, which D1 bought up front |

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
- **It does not measure ALL of an organization's CPU, despite the name.** It
  measures build-slot occupancy for plugin builds — what the platform pays for
  and what can honestly be counted. Pipeline executions run in AWS and are not
  counted until Phase 4, which is why D1 puts that scope in the product copy
  rather than trying to encode it in the name.
- **It does not meter or bill overage (Phase 3c).** A cap plus packs, because no
  overage-billing machinery exists to reuse.
- **It does not fully model CONCURRENCY (D9).** The quota caps a monthly volume;
  the scarce resource is build slots. Two tenants with budget to spare still
  queue behind one buildkitd, and the monthly window makes that more pressing,
  not less, since an account can now spend a month's budget in an afternoon.
  D11's batch class is the first real answer — it gives the queue a priority
  to sort by — but it mitigates contention rather than modelling it, and nothing
  here sells or promises a wait time for a PAID build.
- **It does not sell a faster build YET (D13 decides that it will).** Today
  `buildkit_vcpu` is one global value and buildkitd is a sidecar of the plugin
  pod, so a tenant with a slow build waits rather than paying for more cores.
  D13 settles the product question — machine sizes `1x` / `2x` / `4x`, gated by
  tier and credit-neutral per build — but it cannot ship until buildkitd is
  decoupled into its own runner, which D9's supply ramp and D11's capacity floor
  need as well. One prerequisite, three products.
- **It does not split human from automated builds (D8).** One budget, plus a
  `trigger` label on the build metric so the question can be answered from data
  if anyone asks it again.
- **It does not change `QUOTA_RESET_DAYS` for any other quota (D7).** The
  monthly period is `cpuCredits`-only; every other counter keeps the global
  three-day window.

## Sequencing

**D12 THEN D9, before anything is published.** These are the only items that can
invalidate the tier table rather than refine it, and D12 goes first because it
changes the number D9 has to serve: flattening the wall-minutes column halves the
top tier, taking Enterprise from 208% of the pool to 104% and Business from 93%
to 69%. D9 then sizes the pool against that smaller figure — one reserved
`c7g.large` rather than a ladder nothing can serve. Run them the other way round
and the pool gets sized for a ladder that is about to change.

**What D12 does not buy is an exemption from D9.** At 1,500 builds a month the
top tier needs 45,000 credits even at 20 wall-minutes, so the provisioning
decision survives the flattening — it just gets cheap. No amount of Phase 1–3
work makes a cap the hardware cannot serve into a real product.

**D10 decides what the numbers mean, and D7's window decides whether they are
reachable.** Both are paper decisions — settle them with D9 rather than after it,
because all three move the same table and re-deriving it three times is how a
ladder ends up internally inconsistent.

**D11 belongs in that same sitting, because it changes what D9 has to be true
of.** How much of the free tier's load lands in the batch class, and how low
`PLUGIN_BUILD_CONCURRENCY_DEVELOPER` is set, change what the pool has to absorb at
peak — so deciding D11 after sizing the pool means sizing it for a load whose
shape is still unsettled.

**One piece of infrastructure serves three items, and it belongs with D9.**
Decoupling buildkitd from the plugin Deployment is what D9's ramp needs to add
capacity at all, what D11's reserved standard-class floor needs to make a wait
promise enforceable, and what any faster class (item 9) needs to allocate
per-build. Sequence it once, with D9, rather than discovering it three times.

**And one D11 item should not wait for any of that.** `PLUGIN_MAX_BUILDS_PER_ORG`
is 3 on every tier, so the priority lever D11's conversion argument rests on is
already built and switched off. Making it tier-aware is independent of the pool
size, the class design and the credit multiplier — ship it first and the rest of
D11 gets to be a refinement rather than a prerequisite.

Then **1 → 2 → 3 (with 3b)**, then **4** when pipeline compute matters enough.

**F5 is no longer a naming prerequisite.** An earlier revision tied the name to
it; D1's rename to "CPU credits" makes the unit unreadable-as-wall-clock on its
own, so F5 is sequenced on value rather than on vocabulary. It is still the item
most worth shipping first in the frontend set.

One ordering note that only became visible once the window was monthly:
**Phase 2 is what turns D10's 30% utilisation guess into a measurement.** Until
`cpu_credits_charged_total` has run for a month, every number in the Phase 1
table rests on an assumption nobody has tested, so treat the first month after
Phase 2 as the point at which the ladder is re-derived — not as confirmation
that it was right.

Phase 1 alone is inert — a quota with no meter. Phase 2 makes it real. Phase 3
without Phase 2 would sell capacity against a limit nothing enforces, which is
worse than not selling it.

Phase 4 is independent of 1–3 in mechanism but dependent in meaning: it is what
turns an honestly-scoped build quota into a complete compute quota. Its first
step (an `org_id` label on `pipeline_executions_total`) is worth landing early
regardless, because it is one label and it makes the gap measurable.
