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
   10-minute build at 1.5 vCPU costs 15 of them — and "9,000 build minutes"
   reads as 150 hours when it buys about 100. An abstract unit cannot be misread
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
  hits it can never be admitted on that tier at all. At Developer's 3,000/month
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
x 24 wall-minutes x 1.5 = **900 credits in one day against a 300/day cap**. The
account is refused on the first morning of its release *while holding 8,100
unspent credits for the month*. A daily window does not ration that work, it
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
  1.5 vCPU is 90 credits against Developer's 3,000/month. The constraint stays
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
(24,000) is already 185%** — not just the top two rows. Quote both, because
selling against the ceiling is selling capacity the scheduler never reserved.

**The first fix is therefore to raise `requests`, not to argue about the limit.**
A quota that promises 1.5 vCPU of throughput against a 0.3 vCPU reservation is
promising what the scheduler has not set aside; making requests match the
capacity being sold is what turns the ceiling into the floor.

against the demand-derived ladder (the ratios are period-independent, so this
reads the same whatever window D7 picks):

| Tier | Cap/month | Share of the ENTIRE pool |
|---|---|---|
| Developer | 3,000 | 5% |
| Pro | 9,000 | 14% |
| Team | 24,000 | 37% |
| Business | 60,000 | **93%** |
| Enterprise | 135,000 | **208%** |

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
  tenant.
- Allowing a single tenant at most HALF the pool — a floor worth stating, since
  anything above it means one customer can starve the rest — needs **≥ 6.25
  vCPU**.
- At the shipped 1.5 vCPU the honest top tier is Business-sized (60,000/month)
  and only if it is the sole tenant building — and that is against the CEILING.
  Against the reserved floor the honest top tier is Pro.

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

**What to build, rather than what to assert:**

1. Read the vCPU figure from configuration, which D2 already requires, and
   derive `periodSupply = buildkit_vcpu x 1440 x periodDays` from it.
2. A boot-time check and a test: `max(tier cpuCredits) <= periodSupply x
   SINGLE_TENANT_SHARE`. **And a second check this decision originally missed:
   the FREE-TIER AGGREGATE.** Developer's 3,000/month against a 64,800 ceiling
   means 22 fully-consuming free organizations are the whole platform, and free
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

| Tier | Builds/month at the cap | Normal (30%) | x wall-min x 1.5 vCPU | Normal credits/month |
|---|---|---|---|---|
| Developer | 100 | 30 | 20 | **900** |
| Pro | 250 | 75 | 24 | **2,700** |
| Team | 500 | 150 | 32 | **7,200** |
| Business | 1,000 | 300 | 40 | **18,000** |
| Enterprise | 1,500 | 450 | 60 | **40,500** |

Against the Phase 1 ladder those land at a uniform **3.3x headroom** — the same
factor on every tier, because both sides are linear in the same two assumptions.
So the answer to "is it enough for a month of standard activity?" is **yes, in
aggregate, with room for a month that runs three times hot.**

**The aggregate was never the problem; the SHAPE was.** The same figures under a
one-day window refuse a Pro account's release day while it holds 8,100 unspent
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

## D11 — A DEFERRED build class, and Developer gets only that

**Decision: offer builds a cheaper "run when there is room" class, and make the
free tier deferred-only.**

This is the one lever the plan was missing, and it was missing because the plan
was written looking inward. Both obvious comparables sell latency tolerance:

- **Claude's Batch API — 50% off** for accepting a 24-hour asynchronous window.
- **AWS Spot — roughly 70% off** for accepting interruption.

Same trade in both cases: the customer gives up immediacy, the vendor gets to
smooth its own load. Every discount this plan currently has is a VOLUME discount
(buy more, pay less per unit) or a prepayment discount, and neither of those
helps the platform at all — they reduce revenue without reducing cost or
smoothing demand.

**Builds are the ideal candidate, because the mechanism already exists.** They
go through BullMQ, which carries a priority already; there is no UX to invent
and no new billing machinery — a deferred build is a multiplier at the meter, or
a second cheaper counter.

**And making Developer deferred-only is what turns a discount into a design.**
One change answers three separate problems in this plan:

1. **It closes the free-tier exposure D9 never checked.** Developer holds 3,000
   credits a month against a pool ceiling of 64,800, so **22 fully-consuming
   free organizations are the entire platform** — and free organizations are the
   population a developer platform has most of. D9 bounded a single tenant's
   share and said nothing about the aggregate. Priority bounds it where a quota
   cannot: a deferred build yields to a paid one instead of competing with it.
2. **It de-correlates D9's bursts.** The coincidence D9 worries about — everyone
   rebuilding after the same CVE or base-image bump — is exactly what a deferred
   class spreads out, and the free tier is where most of that volume will be.
3. **It gives Developer → Pro a reason that is not volume.** Today the upgrade
   buys MORE; this makes it buy PRIORITY, which is a far stronger conversion
   lever and is what both comparables do — AWS's free tier is burstable t-class,
   and Claude rate-limits its free tier hardest.

**What it needs:** a priority on the build job (already supported), a credit
multiplier for the deferred class, a stated worst-case wait so "deferred" is a
promise rather than a shrug, and an honest refusal when a deferred queue is
genuinely saturated. The multiplier is a product decision; Claude's 50% is the
natural anchor, and anything cheaper than the upgrade it competes with works.

**What it is NOT.** Not preemption: a deferred build that has started should
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
| Developer | 10 | 100 | 20 | **3,000** |
| Pro | 25 | 250 | 24 | **9,000** |
| Team | 50 | 500 | 32 | **24,000** |
| Business | 100 | 1,000 | 40 | **60,000** |
| Enterprise | 150 | 1,500 | 60 | **135,000** |
| Unlimited | — | — | — | `-1` |

Every row is exact at `buildkit_vcpu = 1.5`. D10 checks these against a month of
normal activity and finds a uniform **3.3x headroom**, which is the point of the
sizing: a standard month fits, and a month that runs three times hot still fits.

**But the table is a DEMAND model and is not sellable as it stands.** Nothing in
this derivation looks at supply, and D9 shows the top two rows exceed what the
shipped buildkitd can deliver — Business takes 93% of the whole pool and
Enterprise 208% of it. The ratios are period-independent, so moving to a monthly
window changes nothing about that: 1.5 vCPU delivers 64,800 credits a month, and
Enterprise's 135,000 is still twice it. Treat the numbers here as the shape of
the ladder and D9's check as the gate on publishing it.

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
  (route, principal, plugin), so "why is our build budget gone?" has an answer.
  Without this the quota is enforceable but not explainable.

## Phase 3 — The pack

```
b('cpu_credits_pack', 'CPU Credits Pack (+500)',
  '500 additional CPU credits / month', { cpuCredits: 500 },
  249, PAID, <sort>,
  { volumeTiers: SEAT_STYLE_VOLUME, maxQuantity: <from D9 supply> })
```

**+500 credits a month, granular, with seat-style volume breaks and a quantity
cap.** Each of those four is a decision the earlier drafts got wrong or left
open; the reasoning is below. A pack grant raises the cap per period, so the
monthly period (D7) sets the unit: +500/month is about fourteen extra builds at
Pro's assumed 24 wall-minutes.

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
  +500 against Pro's 9,000 the pack is **5.6%** of the cap, so Pro's row can be
  retuned without breaking a test. The no-crossing rule is comfortable too
  (9,000 + 500 is nowhere near Team's 24,000).

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
- **Cap the stack.** `stackable` defaults to true and no `maxQuantity` is set,
  so an account could buy arbitrarily many minutes against a pool that delivers
  64,800 a month (D9). D5 added a per-BUILD ceiling for exactly this reasoning;
  this is its pricing-side twin, and without it the catalogue can sell capacity
  the platform has no way to produce. Derive the cap from supply, not from a
  round number.
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
  let the volume curve plus D11's deferred class be the discounts on this
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
that grant the other one. The formula is
`credits/month = (plugins x 10) x wall-minutes x vcpu`, so:

| Pack | Grants | CPU credits it needs | Grants today |
|---|---|---|---|
| `plugin_pack` | +10 plugin builds / period | ~**3,600**/month | 0 |
| `pipeline_pack` | +5 pipelines, +25 plugins (Team) | ~**12,000**/month | 0 |

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
that takes effect within a minute (F-section), the deferred class (D11), and
eventually opt-in overage.

## Phase 3d — The over-cap guard must take `cpuCredits`

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

So add `cpuCredits` to the guarded list. Note that this is the same correction
storage needed, for the same reason and with the same shape: storage was grouped
with the rate quotas on the "they reset" rule, the rule did not apply to it, and
the fix was one entry in that list. The lesson generalises — **the exclusion is
about period LENGTH, not about being a rate** — and the guard's comment should
say so, or the next long-window quota repeats it.

One consequence to design, not just assert: unlike `plugins`, CPU credits are
spent continuously rather than held, so "current usage" against a reduced cap is
a point-in-time reading that will keep rising. Refusing the downgrade outright is
the conservative answer; the alternative — allow it and let the grace band plus
the forecast carry the account to the period boundary — is defensible but needs
the notice to say what is about to happen.

## Phase 4 — Ingest CodeBuild

The honest completion of D1, and **no longer a rename**: D1 takes the final name
up front, so this phase widens what the quota COUNTS and leaves every identifier
alone. AWS reports duration and compute type per build, and `pipeline-manager`
already talks to AWS, so the data is reachable.

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
remained, which stopped being true as the plan grew. These are the real
outstanding items, grouped by when they have to be answered.

*Before Phase 1 ships, because they set contracts:*

1. **The window mechanism (D7).** A rolling 30-day window, or calendar-month
   arithmetic? `nextQuotaResetDate` does day arithmetic with a lazy reset, so
   "aligned to the subscription" is only achievable with the second — and that
   changes the shape of `periodDays`, which is the field Phase 1 moves into
   `QuotaSummary`.
2. **Provisioning (D9).** How much buildkitd capacity to run, and whether
   `requests` rises to match what the ladder sells. The ladder cannot be
   published before this, and the answer costs roughly $150–180/month.
3. **`SINGLE_TENANT_SHARE` (D9).** What fraction of the pool one account may
   hold. Half is the figure the plan argues for; it has not been decided.

*Product judgements, answerable now but not by reading code:*

4. **The wall-minutes column (Phase 1).** How long a build on each tier is
   allowed to take on average. It sets the whole ladder, and the pack size is
   coupled to Pro's row through the ratio bound.
5. **The per-build ceiling N (D5).** Downstream of the ladder, and constrained
   to be ≤ the smallest tier's budget.
6. **`maxQuantity` on the pack (Phase 3).** Downstream of D9's capacity figure.
7. **Whether the pack joins `throughput_bundle` (Phase 3).** Join and reprice
   the combo, or record why the throughput combo omits the throughput that costs
   money.
8. **The deferred class's discount and its wait promise (D11).** Claude's 50% is
   the natural anchor, and the figure has to beat the upgrade it competes with
   without giving the pool away. The stated worst-case wait matters more than the
   discount: "deferred" has to be a promise, not a shrug.
9. **Whether to sell a FASTER class at all (D11's twin).** Both CI competitors
   monetise resource classes and this plan cannot express one, because
   `buildkit_vcpu` is global. Building it means per-build allocation, which
   changes D2's shared-sidecar premise and D9's supply arithmetic — so it is a
   real decision, not a parameter.
10. **The `RATE_PACKS` single-dimension conflict (Phase 3b).** Extend
   `plugin_pack` to grant credits — which forces it out of `RATE_PACKS` and
   gives up the ratio bound and the free-tier guard, as `pipeline_pack` already
   did — or sell credits separately and say so where a buyer reads it.

*Measurements, not decisions — they resolve themselves once Phase 2 runs:*

11. **The 30% utilisation assumption (D10).** The one number here with no
   evidence behind it. `cpu_credits_charged_total` per org against the tier cap
   gives real utilisation after a month, and the ladder should be re-derived from
   that rather than from a guess.
12. **The forecast's reliability early in a period (D7).** It needs a
    minimum-elapsed guard before the monthly window leans on it; how long is an
    empirical question once there is data.

## Checked and NOT a gap: the seat pack

`seat` carries a per-seat capacity invariant — every paid tier holds exactly
100,000 API calls and 200 AI calls per seat, and the pack grants that share so a
bought seat is worth a tier seat. The obvious question is whether it must now
grant CPU credits too.

It must not, because there is no invariant to preserve: per-seat minutes are
**not** constant across the ladder — Pro 9,000, Team 8,000, Business 7,500,
Enterprise 9,000. Recorded so nobody re-raises it.

Worth noticing while here, though: **Pro and Enterprise already sit at exactly
9,000 per seat.** Re-deriving Team to 27,000 and Business to 72,000 would make
the whole column constant, let `seat` carry CPU credits like it carries the
other two, and bring the dimension under the existing invariant test for free.
That is an improvement rather than a defect — and it collides head-on with D9,
since 72,000/month is above what the shipped pool can deliver at all. Decide the
supply question first; this one is downstream of it.

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
said `QuotaCard` formats everything through `fmtNum` and that CPU credits would
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
+500/month pack reading "500 minutes" says far more than "1 pack" — and with
`packUnit` declared the field is TYPED in minutes, so the buyer enters the number
they have in mind rather than a pack count. It is a catalog field now, not a map
to extend.

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
credits where an AI call is one unit, and a base-image bump submits dozens at
once. The monthly period (D7) changes what the hint should SAY rather than
whether it is needed: not "15 of your 85 remaining today" — which a daily window
would have made the honest phrasing — but "about 15 of your 2,900 remaining this
month", alongside the forecast that D7 leans on as its main safety mechanism.

**It no longer carries the naming decision, and that is worth recording.** An
earlier revision made this hint a PREREQUISITE of the name, because
"build minutes" was imprecise about its own unit (a vCPU-minute) and the hint
was the only surface that taught the conversion. D1's rename to "CPU credits"
removes that dependency — an abstract unit cannot be misread as wall-clock — so
F5 stands on its own merits again rather than being load-bearing for the
vocabulary. **Highest-value frontend item here**, and the one an earlier draft of
this plan omitted entirely while calling the frontend work free.

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
| Frontend | Medium | F1/F2 are now catalog entries (the display catalog landed); the work is in-flight reservations, two refusal messages, and the pre-build cost hint |
| 2 | Medium | Two metering hooks, a reserve-and-true-up settle shared with the `plugins` gate, retry pricing, exemptions, ledger attribution |
| 3 | Small–Medium | One catalogue entry, two test-list additions, a Marketplace dimension, a `maxQuantity`, and the grant-granularity decision (which also sets the volume breaks) |
| 3b | Small | Extending `plugin_pack` / `pipeline_pack` grants, plus the ratio invariant test — but it needs the `RATE_PACKS` single-dimension conflict resolved first |
| 3d | Hours | One entry in `checkEntitlementOvercap`, plus the notice copy for what a refused downgrade means |
| D11 | Small–Medium | A job priority (BullMQ already has one), a credit multiplier at the meter, the free tier switched to deferred-only, and the copy that makes the wait a promise |
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
  D11's deferred class is the first real answer — it gives the queue a priority
  to sort by — but it mitigates contention rather than modelling it, and nothing
  here sells or promises a wait time for a PAID build.
- **It does not sell a faster build (D11).** `buildkit_vcpu` is one global
  value, so a tenant with a slow build waits rather than paying for more cores —
  the half of the latency axis both CI competitors monetise and this plan leaves
  on the table.
- **It does not split human from automated builds (D8).** One budget, plus a
  `trigger` label on the build metric so the question can be answered from data
  if anyone asks it again.
- **It does not change `QUOTA_RESET_DAYS` for any other quota (D7).** The
  monthly period is `cpuCredits`-only; every other counter keeps the global
  three-day window.

## Sequencing

**D9 FIRST, before anything is published.** It is the only item that can
invalidate the tier table rather than refine it: at the shipped 1.5 vCPU the top
two rows are undeliverable, and no amount of Phase 1–3 work makes a cap the
hardware cannot serve into a real product. Sizing the pool, or trimming the
ladder to it, is the gate on the rest.

**D10 decides what the numbers mean, and D7's window decides whether they are
reachable.** Both are paper decisions — settle them with D9 rather than after it,
because all three move the same table and re-deriving it three times is how a
ladder ends up internally inconsistent.

**D11 belongs in that same sitting, because it changes what D9 has to be true
of.** If the free tier is deferred-only, the free aggregate stops competing with
paid work and the supply question gets materially easier — so deciding D11 after
sizing the pool means sizing it for a load that will not arrive.

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
