<!--
Copyright 2026 Pipeline Builder Contributors
SPDX-License-Identifier: Apache-2.0
-->

# Plan — Offering the right expansion to the right organization

**A dedicated process that reads an organization's usage and profile, decides
whether an expansion offer is warranted, and spends an existing campaign budget
to make it.**

## Highlights

- **The delivery machinery is already built.** Discounts, campaigns, promotions,
  grant dedupe, per-org caps, budget accounting, spend reconciliation, a
  scheduled evaluator and a full admin surface all exist. This plan adds almost
  none of that.
- **What is missing is TARGETING.** `PromotionContext` — the entire vocabulary a
  promotion can match on — is `{ tier, interval, planPriceCents,
  isFirstSubscription }`. Four static billing facts, and not one of them says
  anything about what the organization actually does with the product.
- **So the seam is narrow and the plan is mostly a signal problem**, not a
  billing one.
- **"Smart" must not mean "an LLM decides who gets money off."** The rules decide
  eligibility and amount; the model is allowed to rank among already-eligible
  offers and to write the sentence. That boundary is the plan's central safety
  decision.
- **Without a holdout, this feature can never be shown to work** — every upgrade
  that would have happened anyway gets claimed by whoever shipped the offer.
- **The account that looks most expansion-ready is often the one least able to
  accept a discount.** A 40% stack floor refuses a coupon on top of a maxed
  combo plus volume curve, so every offer has to be priced before it is promised.
- **A percentage is the wrong instrument for a capacity pack**, and for an
  add-on the account does not yet hold it computes to literally zero.
- **The agent is INTERNAL ONLY and has no public routes.** It writes `Offer`
  rows; billing serves them. A reachable endpoint that mints discounts would be
  the highest-value target in the product.
- **At most one offer per account per 45 days, counted from SEND** with the
  offer's own expiry inside that window — so a 30-day offer is followed by 15
  quiet days. Counting from resolution instead would let a decline earn a faster
  next offer than being ignored.
- **Pressure alone cannot tell an expansion from a churn risk.** A 95% account
  that is disengaging looks identical to one that has outgrown its tier, which is
  why the profile carries trajectory and value, not just level.
- **The best offers need no discount at all.** An account paying for four seat
  packs on Team already pays more than Business costs; and an account that has
  outgrown its tier in two dimensions but not in headcount wants a basket of
  add-ons, not a discounted tier it will half-use.
- **Today the headline offer cannot be accepted at its own price**:
  `PlanChangeModal` shows no discount at all, so a 50%-off Business offer opens
  the upgrade modal at $249. That is a prerequisite, not polish.
- **A seat-scaled tier price cannot be built from a coupon.** A discount has no
  binding to a live dimension and no re-evaluation hook, so "priced for your four
  seats" means "priced for the seats you had the day it was minted".

## Overview

The pricing model sells expansion three ways: move up a tier, buy a capacity
pack, or buy a feature add-on. Nothing in the product notices when an
organization has grown into one of those and says so. The quota service already
tells an org when it is near a limit; it has no idea that the limit has a price
attached.

This plan puts a process between "what the organization is doing" and "what the
catalogue sells", and lets it spend a bounded campaign budget to close the gap.

## Why this is possible at all

Four pieces of machinery already exist, and together they are most of the work.

**1. The discount codec and record** (`api/billing/src/models/discount.ts`). A
mintable discount carries `value`/`unit`/`kind`, an optional `campaign`, an
`alias` for public promos, a `targetOrgId` binding, `maxRedemptions`,
`timesRedeemed`, `redeemBy`, `appliesToTiers`, `appliesToBundles` and an
`externalRef` for provider fulfillment. The record is the authority for
redeemability, and revoking is flipping `isActive`, which kills every token
minted for that id at once.

**2. Campaigns** (`models/campaign.ts`), which hold what cannot be expressed per
code: `budgetCents` / `spentCents`, `grantsCount`, `exclusive`, a
`startsAt`/`endsAt` window and `isActive`.

**3. Promotions and an evaluator** (`models/promotion.ts`,
`helpers/promotion-engine.ts`). A promotion has a `trigger`, `conditions`, a
`budgetCents`, a `perOrgCapCents`, `maxGrants`, and one-time versus `recurring`
kinds. `batchEvaluatePromotion` walks `activeSubscriptionCursor()`, builds a
context per subscription, checks `matchesConditions`, and calls
`grantPromotionToOrg` — with budget exhaustion, already-granted and fail-soft
error paths all handled.

**4. A scheduled runner** (`helpers/promotion-backfill.ts`) using
`createScheduler` with `leaderLockKey('billing', 'promotion-backfill')`, which
reconciles advisory spend from the ledger before catching up missed grants.

**And the guard rails are already there, which matters more than the features.**
`config.ts` caps a percent coupon at mint time (default 50, deliberately not
100, because "at 100 a mistyped coupon is a $899/mo giveaway"), caps a fixed
amount at $20,000, and separately bounds the whole stack of
interval + volume + combo + coupon reductions. An automated granter is exactly
the actor those ceilings were written for.

## What the machinery does NOT give us

**`PromotionContext` is the whole targeting vocabulary, and it is static.**

> `{ tier, interval, planPriceCents, isFirstSubscription }`

`PromotionConditions` matches on `tiers`, `intervals` and
`firstSubscriptionOnly`. `PromotionEvent` is one of `subscription_created`,
`plan_change`, `manual`, `referral` — every one a billing lifecycle event.

So a promotion can say "20% off annual for Pro accounts on their first
subscription". It cannot say "this account has spent three consecutive periods
above 90% of its plugin-build cap", which is the only kind of statement an
expansion offer should rest on.

**There is no targeting or segmentation logic anywhere in the repository.** No
propensity model, no segment definitions, no usage-derived eligibility.

**There is no marketing-consent model.** Nothing in any service's `src` tracks
whether an organization has agreed to be sold to, or has asked not to be.

## D1 — Call it OFFERS, not a sales agent

**Decision: the service is `api/offers`, the thing it produces is an `Offer`, and
the word "agent" does not appear in the product surface.**

"Sales agent" describes who benefits, not what the thing does, and it sets an
expectation the plan does not meet: a conversational salesperson that negotiates.
This process does something narrower and more defensible — it notices that an
account has grown into something the catalogue sells, and makes a bounded,
auditable, expiring offer.

The name also has to survive the thing getting good. If an `Offer` record is the
unit, then "why did this account get 20% off?" is answerable by reading one row,
and the same record serves the admin surface, the audit trail and the lift
measurement. A record called a "sales agent decision" answers nothing.

**`offers` collides with nothing.** The billing routes are `addons`,
`campaigns`, `discounts`, `promotions`, `marketplace`, `subscriptions`, `usage`,
`billing-summary`, `read-plans`, `support-incidents`, `admin-subscriptions` and
`stripe-webhook`.

## D2 — Extend the existing engine's vocabulary; do not build a second one

**Decision: the agent computes SIGNALS and widens `PromotionContext` /
`PromotionConditions` to match on them. It does not grant money itself.**

This is the plan's most important structural choice, and the reasoning is that
everything dangerous is already solved on the existing path: grant dedupe via
`dedupeKey`, `perOrgCapCents`, budget exhaustion as a first-class outcome,
advisory-spend reconciliation against the ledger, audit on mint, the mint-time
ceilings, and the stack bound.

A parallel granter would have to re-earn all of it, and the failure mode of
getting it wrong is handing out money. So:

- the agent writes an `Offer` and, where the offer is a discount, calls the
  SAME `grantPromotionToOrg` path the admin surface and the backfill use;
- a new `usage` block on `PromotionConditions` carries the predicates;
- `PromotionContext` gains the computed signals, so `matchesConditions` stays the
  single place eligibility is decided.

**One consequence to accept.** `batchEvaluatePromotion` currently builds its
context from a plan lookup per subscription and an optional `countDocuments`.
Usage signals cannot be computed inside that loop at acceptable cost, which is
why Phase 0 builds a signal store the loop READS rather than a computation the
loop performs.

## D3 — A dedicated image, with the cost written down

**Decision: `api/offers` ships as its own service and image, as specified. The
cheaper alternative is recorded here because the choice should be visible.**

**What a tenth service costs in this repository.** There are nine today
(`ask`, `billing`, `compliance`, `image-registry`, `message`, `pipeline`,
`plugin`, `quota`, `reporting`). Adding one means manifests in three Kubernetes
trees (40 / 44 / 47 files today) plus docker compose, a NetworkPolicy, an Istio
entry, a Prometheus scrape target, its own Redis/Mongo wiring, and the
deploy-contract drift tests that keep the trees in lockstep. That is real work
and it is work this plan does not otherwise need.

**The cheaper alternative, for the record:** a scheduler inside `api/billing`,
exactly like `promotion-backfill`. It would need no manifests, no policy and no
new scrape target, and the existing scheduler + leader-lock pattern is proven.

**What justifies the separate image anyway**, and it is worth being specific
rather than appealing to tidiness:

- **It reads across services.** Quota counters, storage breakdowns, subscription
  and add-on state. In billing that is a set of internal calls from a service
  that owns none of the data.
- **It runs AI calls (D5) with long, bursty latency.** Billing serves
  latency-sensitive subscription routes; an AI cycle that stalls should not share
  a pod with them.
- **Its blast radius should be separately containable.** A process that spends
  money on a schedule is one you want to be able to scale to zero, or stop,
  without stopping billing.

**And D13 reduces this bill.** A service with no public routes needs no Istio
ingress entry, no auth middleware and no route-table contract — the expensive
half of a new service here is its public surface, and this one has none.

**But sequence the extraction, do not lead with it.** Phases 0–3 are testable as
a scheduler inside billing, and shipping them that way proves the signals and the
rules before paying the deployment cost. Phase 5 extracts. If the rules turn out
to be wrong, that is a far cheaper place to find out.

## D4 — Five classes of signal, not one

**Decision: the profile carries PRESSURE, TRAJECTORY, VALUE, PROFILE and TIMING.**

An earlier draft of this decision listed only pressure signals. Pressure answers
*can we sell them more of what they have* — and not one of the questions that
follow it: should we, which SKU, when, and how much. **An account at 95% of a cap
that is quietly disengaging is a churn save, not an expansion, and offering it an
upgrade is the worst available outcome.** A pressure-only profile cannot tell
those two accounts apart.

### Class 1 — Pressure: what they are running out of

Every source here already exists; nothing needs instrumenting.

| Signal | Source today |
|---|---|
| Per-type usage and limit, per period | the quota service's counters, surfaced by `/usage` and the quota summary |
| Threshold crossings (80 / 90 / 100%) | `crossedThresholds` in `api/quota/src/services/threshold-notifier.ts` |
| Registry bytes, and each tag's marginal cost | `computeOrgStorageBreakdown` in image-registry |
| Add-ons held against the tier's own caps | the subscription record plus `DEFAULT_TIER_LIMITS` |
| Seats filled against the seat cap | the org membership count, enforced at invite time |

**The headline is the one nobody has to build.** `threshold-notifier` already
computes a 90% crossing, writes the notice copy and emits `quota.threshold`. That
crossing IS the expansion moment — the account has just been told it is running
out of something with a price attached — and the notice does not mention that a
pack exists.

### Class 2 — Trajectory: how fast, and therefore when

**"At 90%" is a weaker signal than "was at 40% three months ago, now at 85%".**
Velocity says *when* the wall arrives, which is what lets an offer land before it
rather than at it. Pressure alone can only ever offer late.

**The formula already exists, in the wrong place.** `QuotaCard.tsx` projects
period-end usage inline:

> `projected = used * (total / elapsed)`

That is React component arithmetic. There is no server-side burn rate anywhere,
so nothing but the card can use it. **Extract it to api-core beside the quota
catalog** and three consumers share one projection: the card, the threshold
notice, and this agent. Doing it the other way — reimplementing the projection
here — guarantees the page and the offer eventually disagree about the same
account.

Derived from it, and this is where the judgement lives:

- **Sustained pressure** rather than a spike: N consecutive periods above a
  threshold, which separates an account that has outgrown its tier from one that
  had a busy week. A spike-triggered offer is the fastest way to make this
  feature feel like spam.
- **Direction.** Usage trending DOWN is a disqualifier, not a weaker version of
  up. It is the clearest churn-risk signal available and it looks identical to
  pressure if only the level is read.

### Class 3 — Value: whether the product is working for them

**This is the class with no data behind it, and the gap is load-bearing.** There
is no `lastLoginAt`, `lastSeenAt` or `lastActiveAt` anywhere in the repository, so
**"are those five seats actually used?" cannot be answered today.**

That question is the key disqualifier for the strongest offer in the plan. An org
holding 5 seats with 2 active people is already paying for shelfware; selling it
8 seats manufactures a cancellation at renewal. Without seat activity, a
seat-driven tier offer is being made blind.

**Cheapest honest form:** a per-member last-activity stamp written on the
authenticated-request path the audit layer already traverses. Coarse is fine —
day granularity answers the question. Open item 10.

Two more value signals that DO have sources: build success rate (a high failure
rate means the product is not working, so do not sell more of it) and whether an
add-on the account already holds has been exercised at all.

### Class 4 — Profile: what kind of organization this is

Available today, and entirely unused by the plan's earlier draft.

| Signal | What it indicates | Source |
|---|---|---|
| `idpConfigs` configured | enterprise-shaped; the caps are 5 / 5 / 10 / unlimited, so an org adding IdPs is climbing | quota limits + the IdP records |
| `childOrgCount` > 0 | they have built teams, so structurally a larger organization | already computed for `/user/organizations` |
| Compliance add-ons held | regulated, which changes the objection set entirely | subscription add-ons |
| `listings` used | a marketplace publisher, whose motivation is reach rather than capacity | quota counters |
| Tenure, and tier history | how settled they are, and whether they have moved before | `Subscription`, `plan_change` events |

### Class 5 — Timing: when the offer should land

The subscription carries `currentPeriodEnd`. Two consequences the earlier draft
ignored completely:

- **An annual upgrade offered near renewal converts far better** than the same
  offer mid-term, because the decision is already on the account's desk.
- **Credits offered just after a period reset are pointless** — the account has a
  full budget and no felt problem. The same offer a week before the reset is
  about something they are living with.

### The crossover signal, which deserves naming on its own

**How much is this account spending on packs, against the next tier's price?**

Pure arithmetic from the subscription record — no inference, no model, no
threshold to tune. And it produces the only offer in this plan that needs **no
discount at all**: no renewal cliff (open item 9), no stack-floor risk (D9),
no campaign budget spent.

Worked: Team includes 3 seats at $79. Four Member Seat packs at $49.99 reach
**$278.96 for 7 seats** — against Business at **$249 for 8 seats**, with double
the storage, pipelines and plugins and unlimited dashboards and alert rules. That
account can simply be shown it is paying more for less.

**Ship this before anything that requires a discount.**

### Co-occurrence is the intelligence

Counting pressured dimensions is not enough; WHICH dimensions are pressured
together names the SKU. This map is the part of the plan that makes it smart, and
an earlier draft left it implicit:

| Pressured together | What the account is | SKU to offer |
|---|---|---|
| `plugins` + `cpuCredits` | a heavy build shop | `pipeline_pack`, or the tier |
| `apiCalls` + `automationCalls` | automating against the platform | `automation_pack` |
| `storageBytes` + `plugins` | accumulating images | `storage_pack` — **or GC advice, which is a reason not to sell** |
| `aiCalls` alone | leaning on generation | `ai_pack` |
| `seats` + anything else | outgrown the tier, not a dimension | the tier |

Without the map the agent can only offer a pack for the single most-pressured
dimension, which is the naive answer and often the wrong one — and in the
storage case the right answer may be to tell them to delete tags rather than sell
them disk.

**One dimension's pressure never implies a tier.** A tier offer requires breadth
(several dimensions under pressure, or seats), because a single pack relieves a
single dimension far more cheaply and an account that notices will say so.

## D5 — The rules decide; the model ranks and writes

**Decision: eligibility and amount are DETERMINISTIC. The model may choose among
offers the rules already permit, and may write the message. It may not create an
offer, change an amount, or widen eligibility.**

This is the boundary that makes the feature safe to ship, and the reason is not
abstract caution: the existing coupon ceilings were written because one mistyped
percent could be an `$899/mo` giveaway. A model that could set the number is that
mistake with an API.

So the split is:

- **Rules** (testable, auditable, cheap): does this account qualify, for which
  SKU, at which amount, within which campaign budget, given frequency caps and
  consent.
- **Model** (Phase 4, optional): given two or three permitted offers, which is
  most apt for this account, and what single sentence explains it in the
  account's own terms — "your builds have been at the cap since the 3rd" beats
  "upgrade now".

**Everything the model is allowed to influence is already bounded by something
else.** It cannot exceed the campaign budget, the `perOrgCapCents`, the mint-time
ceiling or the stack bound, because it never touches the grant path — it picks a
row the rules produced.

**And it must be optional.** The feature has to work with the AI path disabled,
because `aiCalls` is itself a metered quota and because an AI outage must not
stop expansion offers. The rules pick the highest-ranked offer by a static
priority when the model is off or unavailable.

## D6 — Consent, frequency, and the moments not to sell

**Decision: offers are opt-OUT with a real unsubscribe, capped in frequency per
account, and suppressed during a set of named states.**

Nothing in any service's `src` tracks marketing consent today, so this is new —
but the pattern to copy is already in the repository.
`api/reporting/src/routes/public-reports.ts` serves
`POST /public/report-recipients/unsubscribe` with a token, and documents why it
is a POST: "security scanners and corporate link-prefetchers follow GETs", so an
unsubscribe on GET gets triggered by a scanner and the recipient never learns why
the mail stopped. RFC 8058 one-click is a POST for the same reason. Copy that
shape exactly rather than inventing a second one.

### The switch: `offersEnabled`, default TRUE

**Decision: an account-root boolean defaulting to true, on the settings object
that already carries the quota-notice switch, gated on `billing:manage`.**

The precedent is exact, so this is a copy rather than a design.
`QuotaNoticeSettings` already carries `enabled`, `webhookUrl`, `thresholds[]` and
an instance-level `noticesEnabledOnInstance`, scoped to "the account root the
settings belong to", rendered by `QuotaNoticeSettingsCard` and served from
`api/quota/src/routes/usage-routes.ts`. `offersEnabled` sits beside it.

Four properties, each chosen rather than inherited:

- **Default true.** An account that has never expressed a preference receives
  offers; this is opt-OUT, and D6's unsubscribe is what makes that defensible.
- **Account-root scope, not per-member.** An offer is a commercial decision only
  someone with billing authority can act on, so a per-member toggle would let a
  developer switch off something the owner wants.
- **Gated on `billing:manage`**, for the same reason. It is not a notification
  preference every member may flip.
- **An instance-level switch too**, mirroring `noticesEnabledOnInstance` — and it
  defaults OFF where billing is disabled, because a deployment with nothing to
  sell should not be making offers. A self-hosted operator turning the whole
  feature off must not have to visit every account.

**The per-address unsubscribe is a DIFFERENT granularity, and conflating them is
a bug.** `api/reporting`'s unsubscribe stops mail to one address. One admin
unsubscribing themselves must not silently disable offers for the organization,
and the org switch must not resurrect mail to an address that asked to stop. Two
records, both consulted.

### Frequency: at most one offer per 45 days, measured from SEND

**Decision: the quiet period runs 45 days from when the offer is SENT, and the
offer's own expiry window counts INSIDE it.** A 30-day offer is followed by 15
days of nothing, and the next offer can be made on day 45.

**So the invariant is a RATE, not a gap: at most one offer per account per 45
days.** That is the anti-flooding guarantee, and it is the one an account can
actually perceive — what they experience is how often something arrives, not how
long the silence between arrivals was.

**An earlier draft measured from RESOLUTION instead, and that was wrong for a
reason worth recording**, because the mistake is easy to repeat. Resolution means
redeemed, declined, or expired — so a *declined* offer resolves on day 2 and
starts the clock immediately, while an *ignored* offer resolves on day 30 when it
lapses:

| | Resolves | Next offer, from resolution | Next offer, from send |
|---|---|---|---|
| Declined early | day 2 | **day 47** | day 45 |
| Ignored, 30-day expiry | day 30 | **day 75** | day 45 |

From resolution, **declining earns a faster next offer than ignoring** — which
contradicts this decision's own rule that a decline lengthens the window, and
rewards the account that engaged with the one thing it asked not to receive.
Measuring from send makes both 45, and the decline backoff then applies on top,
in the direction it was meant to.

It also makes the cadence independent of the expiry length. From resolution, a
longer expiry silently lengthened the whole cycle; from send, expiry is a
decision about how long the offer stands and nothing else.

**One constraint this creates:** the expiry must be shorter than the quiet period,
or offers overlap and the rate is undefined. 30 days against 45 leaves a sensible
margin; an expiry at or past 45 is a configuration error and should be refused
rather than clamped.

Three more properties:

- **Global, not per offer type.** A pack offer must silence a tier offer as well.
  Per-type caps allow three or four solicitations inside one window, which is
  flooding with extra steps — and "you sent me something three weeks ago" is how
  the account experiences it regardless of which SKU it was.
- **Acceptance is governed by the same clock.** A buyer is receptive, which is
  precisely why offering again days later reads as pressure rather than service.
- **A decline lengthens the window rather than resetting it.** 45 days from send
  is the floor; a declined offer earns more on top, which is the remaining half of
  open item 6.

**No new store is needed.** The `Offer` record from Phase 2 carries its sent-at
timestamp, so "the most recent offer, and was it within 45 days" is a query rather
than a counter to maintain — and measuring from send means the answer does not
depend on the row's status, which is one less way for it to be wrong.

**And the quiet period governs SOLICITATIONS, not DISCLOSURES.** F2 (what a limit
costs, on the quota card) and F3 (an account's real spend against the next tier)
are always-visible information, not offers. Suppressing them during a quiet
period would make the product worse to protect the account from being sold to —
the opposite of the intent. Nothing in the quiet period may hide a price the
account is entitled to see.

**Suppress entirely while any of these hold**, because an offer landing in one of
them does active damage:

- an open support incident (the support add-on already models contacts and
  incidents);
- a failed payment or past-due subscription;
- an account inside its first N days, which has not finished evaluating;
- an account in the holdout (D7);
- **an account that recently DOWNGRADED** — it has just told you it is cutting
  cost, and an upsell is the least welcome possible reply;
- **an account whose usage is trending down** (D4 Class 2). Falling usage at a
  high level looks identical to pressure if only the level is read, and it is a
  churn signal, not a buying one;
- **an account with high support volume or a high build-failure rate** — the
  product is not working for them, so selling more of it is indefensible;
- **an account holding an unexercised add-on.** It has not used what it has;
  a second one is not the problem.

**The suppression counts are a product metric, not plumbing.** A feature
suppressing almost everything is misconfigured rather than careful, and that is
only visible if every reason is counted separately (Phase 6).

## D7 — A holdout, or the feature is unfalsifiable

**Decision: a deterministic 10% holdout by a hash of the root org id, never
offered to, from the first cycle.**

Expansion revenue is the easiest thing in a product to claim and the hardest to
prove. An account that was going to upgrade this month will upgrade this month,
and if it received an offer first, the offer gets the credit. Without a control
group there is no number anybody should believe.

Deterministic by id hash rather than random per cycle, so an account's holdout
membership is stable — a account that flips in and out of the holdout is in
neither group.

**And it has to exist from the beginning.** A holdout added after launch cannot
measure the launch, which is the measurement that decides whether any of this
was worth building.

## D8 — Fail CLOSED, unlike the path it feeds

**Decision: any error in signal computation, rule evaluation or consent lookup
results in NO offer.**

`batchEvaluatePromotion` is deliberately fail-soft: a grant that throws is logged
and the loop continues, which is right for an admin-triggered campaign where the
alternative is one bad row stopping a run.

The inverse is right here. The cost of not making an offer is a deferred sale;
the cost of making a wrong one is money, or a message to an account that asked
not to receive it. So an unreadable consent record, a stale `UsageProfile` or a
quota service that cannot answer all mean the same thing: skip this account this
cycle, count it, and move on.

**This mirrors the quota service's own `QUOTA_FAIL_CLOSED` reasoning** — when the
answer cannot be confirmed and the action costs something, do not take it.

## D9 — Pre-flight every offer, because the stack floor can refuse it

**Decision: no offer is made until it has been priced through the existing
preview path. An offer the system will not honour is worse than no offer.**

`config.ts` carries a `floorPercent` (default 40): the account must retain at
least 40% of list, so the whole stack of reductions cannot exceed 60% off. The
comment explaining it names a scenario almost exactly:

> *"a scoped coupon on a bundle that already earns volume takes a second slice of
> the SAME base — Team with 5 Seats + Team Usage Analytics + the Team Growth
> combo + a scoped 50% code reaches 80% off list today. 40 is chosen so the
> catalog's own maxima remain exactly reachable — a 30% combo plus a 30% volume
> curve is 60% off, landing on the floor — and a coupon on top of a maxed stack
> is what gets refused."*

**So the account that looks most expansion-ready is often the one least able to
accept a percentage.** An org already holding a combo and earning a volume curve
has spent its discount headroom; a 50% offer on top of it is refused at
redemption — which is to say, after it was promised. That is the worst possible
ordering, and it is invisible to any rule that reasons only about usage.

`promotion-engine.ts` already exports `previewPromotion`, used by the admin
routes. The agent calls it before writing an `Offer`, and a preview that comes
back refused or below a materiality threshold is a suppression reason (D6), not
an offer.

**And the pre-flight has to price what the account LOSES, not only what it
gains.** `AddonPreviewModal` already warns that a change "ends your {name}
discount", so an upgrade or a compose basket can terminate a discount the account
is currently holding. An offer whose net effect is negative once that termination
is counted is worse than no offer, and only the preview path knows.

**One more ceiling worth stating.** `maxPercent` defaults to **50**, so a 50%
offer sits exactly ON the mint-time ceiling with no headroom. Any offer deeper
than half price is not a pricing decision, it is a config change to the bound
that exists to stop a mistyped coupon becoming an `$899/mo` giveaway.

## D10 — Match the instrument to the SKU's price scale

**Decision: percentage discounts for TIER moves; nothing for capacity packs
until a quantity instrument exists.**

A percentage is the right instrument when the thing being discounted is
expensive. It is close to useless when it is not, and the catalogue spans two
orders of magnitude:

| Offer | List | 50% for a year is worth |
|---|---|---|
| Business tier | $249 / mo | **$1,494** |
| CPU Credits Pack x 4 | $9.96 / mo | **$59.76** |

**And the pack case has a structural problem on top of the small number.** The
discount model sizes a `percent` discount scoped with `appliesToBundles` against
the subtotal of those bundles **for bundles the account HOLDS** — and says
explicitly that "for `unit: 'percent'` with no matching held bundle the credit is
0 (nothing to take a percentage of)". An acquisition offer — *buy the pack you do
not have, half price* — therefore computes to **zero** when expressed that way.

Expressing it at all means `unit: 'dollar'` with a hand-computed cents amount,
which works and which an automated agent is well suited to, but the amount is
then small enough to question whether it moves anybody.

**What a capacity pack actually wants is free UNITS, and that is not
expressible.** Every discount grants cents of usage credit and "cannot grant a
bundle the account does not hold". Granting 2,000 CPU credits outright is an
entitlement, not a discount, and no machinery here does that.

**So the honest conclusion is that the tier offer is the one worth building
first**, and the pack offer is either a `dollar` amount nobody will notice or a
new entitlement-granting instrument this plan does not scope. Recorded as open
item 8 rather than pretended away.

## D11 — Discount depth runs INVERSE to urgency

**Decision: the deeper discount goes to the marginal account, not the desperate
one.**

D5 says the rules set the amount and gave no principle for it. The intuitive
principle is backwards, and expensive:

- An account **200% over** its cap will buy the capacity regardless — it has a
  live problem and no alternative. Discount shallowly or not at all; a deep one
  here is margin given away on a sale that was already closing.
- An account at **85%** is genuinely undecided. It can wait, trim, or leave. This
  is where a discount changes an outcome, and where the depth is earned.

A naive system does the opposite, because the most pressured account looks like
the hottest lead. It is the hottest lead, which is exactly why it needs the least
help.

**Depth is also bounded before it is chosen, not after.** `maxPercent` (default
50) caps the mint, `floorPercent` (default 40) caps the stack, and D9 prices the
offer through `previewPromotion` first — so the rule picks a depth within a
window the catalogue has already narrowed.

## D12 — Log outcomes and retune the rules; do not learn online

**Decision: every offer's outcome is recorded, and the rules are retuned from
that record on a human cadence. Nothing adjusts itself.**

An earlier draft measured against the holdout and then did nothing with the
measurement — the plan had no path from "this did not work" to "this changed".

**What gets recorded** is the whole decision, not just the result: which signals
fired, which SKU was offered, at what depth, from which campaign, and what the
account did. That record is already most of the `Offer` row from Phase 2; the
addition is the outcome and the horizon it is judged over.

**And one outcome distinction matters more than the headline rate: did the
account buy what was offered, or something else?** Buying something different
means the nudge worked and the targeting did not — the most actionable failure
available, and indistinguishable from a win if only conversion is counted.

**Why not online learning.** Three reasons, in order of weight: the thing being
adjusted is money, so a bad adjustment is a refund conversation rather than a
worse ranking; the volume will be far too low for a feedback loop to converge
before the catalogue itself changes under it; and a rule a person tuned can be
explained to the account, which an adjusted weight cannot. The model stays inside
D5's boundary — ranking and copy — and the rules stay inspectable.

## D13 — INTERNAL ONLY, with no customer-facing surface of its own

**Decision: `api/offers` exposes no public routes. It is a worker. Everything a
customer or an admin sees is served by billing's existing routes reading the
`Offer` rows this service writes.**

An earlier draft never said this, which left the most important property of the
service implicit — and the one place implicitness is least affordable, because
**this process mints discounts.**

### Why it is not negotiable

An externally reachable endpoint that can mint a discount is the highest-value
target in the product. The mint-time ceilings in `config.ts` exist because a
single bad mint is an `$899/mo` giveaway; those ceilings are the second line of
defence, and the first is that nothing outside the cluster can reach the minter
at all.

### Internal in three distinct senses, all required

- **No customer-facing routes.** The agent decides and writes; billing serves.
  This is a real architectural consequence, not a deployment detail — see below.
- **Any HTTP surface it does have is `/internal/*` behind
  `requireServicePrincipal`**, the convention already in use across billing,
  image-registry and message (`permission-gates.ts:189`, tagged
  `{ kind: 'servicePrincipal' }`). In practice that is a cycle trigger and a
  health endpoint, nothing more.
- **Network-level**: a NetworkPolicy granting egress to the services it reads and
  **no ingress at all**.

### What this changes about F4 and F8

**The customer-facing offer surface and the admin view belong to BILLING, not to
this service.** F4's offer card, its decline verb and its server-side dismissal,
and F8's admin tab, are all routes on `api/billing` reading and updating `Offer`
rows. That is the right home regardless of this decision — they sit beside
`DiscountRedeem`, `PromotionDetailDrawer` and `BillingAdminTabs`, which is where
a user already goes for anything commercial — and it means the frontend gains no
new API host.

### And it makes D3's dedicated image CHEAPER than D3 costed it

D3 enumerated the cost of a tenth service as manifests across three Kubernetes
trees plus docker, a NetworkPolicy, an Istio entry, a Prometheus scrape target
and the drift tests. A route-less worker needs **fewer** of those: a Deployment, a
NetworkPolicy with egress only, and a metrics scrape. No Istio ingress entry, no
public auth middleware, no route-table contract, no frontend disposition map
entry.

So internal-only strengthens the case for the separate image rather than
weakening it: the expensive half of a new service is its public surface, and this
one has none.

**One honest caveat.** A route-less service is a **new shape** in this
repository — all nine existing services expose routes — so the manifests have no
exact template to copy, and the Prometheus scrape needs whatever the
`kubernetes-pods` job keys on rather than a Service fronting an API. Cheaper than
a full service, but not free, and not a copy-paste.

## Two worked examples

**Example A — Team at 5 seats, offered Business.** The strongest signal in the
catalogue, because it is arithmetic rather than inference.

Team includes **3** seats, so an org running 5 has bought two Member Seat packs at
$49.99 (no volume break — that needs 5 units):

| | Today | Business at 50% for a year | Business at list |
|---|---|---|---|
| Plan | $79.00 | $249.00 | $249.00 |
| Seat packs | $99.98 (2 x $49.99) | — (8 seats included) | — |
| Discount | — | −$124.50 | — |
| **Monthly** | **$178.98** | **$124.50** | **$249.00** |

The offer **saves $54.48/month** — about $654 over the year — while raising seats
from 5 to 8, doubling storage and pipelines and plugins, and taking dashboards
and alert rules to unlimited. It is a good offer and the agent can compute every
figure in it.

**But it has a cliff, and the cliff is the risk this example teaches.** At
renewal the account goes to $249, which is **$70.02/month more than it pays
today**. An account that upgraded for the discount rather than for the capacity
will try to leave — and if it has grown into its 8 seats,
`checkEntitlementOvercap` will refuse the downgrade until it removes members. A
discount that converts an account into feeling trapped is worse than no
conversion.

**The pack-versus-tier crossover is the version with no cliff.** Team plus packs
reaches Business's $249 at **four** packs — seven seats — so an account at 6 or 7
seats can be shown that it is paying more for less, with no discount at all. That
offer survives renewal because it was never subsidised.

**Example B — Pro running out of CPU credits, offered the pack.** Pro's planned
budget is 11,250 credits a month; an account repeatedly exhausting it needs
roughly 4 packs to get comfortable, which is $9.96/month.

Half off for a year is **$59.76 of value**, and per D10 it cannot even be
expressed as a scoped percentage until the account holds the pack. The signal
here is excellent — sustained credit exhaustion is exactly what D4's sustained
pressure is for — and the instrument is wrong. The right response to this signal
is probably **Pro to Team** (11,250 to 22,500 credits, and everything else
doubles), which is a $40/month step and a far better fit for a percentage.

**Example C — Team whose usage warrants Business, but with too few seats to
justify it.** The instinct is to offer Business at a price scaled to their seat
count. Business is $249 for 8 seats, so $31.13 a seat; a four-seat account would
pay $124.52 — which is, not coincidentally, about half price.

**It is expressible, and it is still the wrong instrument.** A discount is a
fixed `value`/`unit` with a window; `DiscountDocument` has no binding to a live
dimension and no re-evaluation hook. So a price "scaled to seats" is a price
scaled to the seats they had on the day it was minted:

- **It never re-prices.** They hire a fifth person and nothing changes, so the
  per-seat story was never true. Make it re-price and you have built per-seat
  pricing out of a coupon, and the account discovers that at the worst moment.
- **It is permanent by implication.** The justification holds as long as the seat
  count does, so this is not a promotion with an end — and a standing
  Business-at-$124.50 sits BELOW Team-plus-two-packs at $178.98, which inverts
  the ladder for anyone who learns about it.

**The better answer is to compose, not to discount.** A four-seat account does
not want Business; it wants two or three things Business happens to include. Most
of them are already purchasable from Team:

| | Price | Team-eligible |
|---|---|---|
| `pipeline_pack` (+5 pipelines, +25 plugins) | $29.99 | team, business, enterprise |
| `storage_pack` (+10 GB) | $19.99 | all tiers |
| `advanced_reporting` | $30.00 | developer, pro, **team** |
| `team_usage_analytics` | $30.00 | **team**, business |

A Team account short of pipelines, storage and reporting composes that for about
**$110/month on top of $79** — keeping four seats instead of paying for eight,
with no discount, no cliff and no budget spent.

**And the ladder is protected by an invariant that makes this safe rather than
exploitable.** The bundle-sizing test holds one basket, summed across dimensions,
at or under the Team-to-Business delta of $170 — so composing the FULL Business
capacity is correctly more expensive than upgrading. Business's API jump alone
(300k to 800k) is twenty `api_pack`s at $239.80. Composing everything loses;
composing **only the dimensions actually under pressure** wins, and knowing which
those are is precisely what D4's co-occurrence map is for.

**So this example names a third offer type, not a third discount.** Alongside
*upgrade the tier* and *buy a pack*, there is *compose a basket* — and it is the
right answer for exactly the account in this example: one whose usage has
outgrown its tier in two or three dimensions while its headcount has not.

**The real finding underneath is a catalogue gap, and a coupon should not fill
it.** There is no SKU for "a small team that needs large-tier features", because
tiers bundle capacity with seats. If that account type turns out to be common,
the answer is a pricing-model change made deliberately — not an automated agent
quietly inventing per-seat pricing one coupon at a time.

**Which is the general lesson all three examples carry: the signal says an account is
constrained; it does not say which SKU relieves it.** D4's headroom shape decides
that, and getting it wrong in the cheap direction leaves money on the table while
getting it wrong in the expensive direction is an overreach the account
remembers.

## Phase 0 — The signal store

A `UsageProfile` per root org, recomputed on a schedule and persisted, carrying
the signals in D4 plus the period they were computed for.

Persisted rather than computed on demand for the reason D2 gives: the evaluator
loop cannot afford cross-service reads per subscription. It is also what makes
the rules testable — a rule is a pure function of a profile.

**Staleness is a first-class field**, not an assumption. A profile older than its
period is not a profile; D8 says skip the account rather than offer against
figures that may predate a tier change.

**Two pieces of groundwork belong here and both have value without the agent:**

- **Extract the burn-rate projection from `QuotaCard.tsx` into api-core** (D4
  Class 2), so the card, the threshold notice and the profile share one formula
  instead of the page owning it privately.
- **Add the per-member activity stamp** (D4 Class 3), which is the only new
  instrumentation this plan requires and the disqualifier that keeps the seat
  offer from backfiring.

**And ship the crossover signal first (D4).** It needs neither of the above, no
discount, no campaign and no model — just arithmetic over the subscription — so
it is the earliest point at which this plan can produce a defensible offer.

## Phase 1 — Usage predicates on the existing engine

Widen `PromotionConditions` with a `usage` block and `PromotionContext` with the
profile, so `matchesConditions` remains the single place eligibility is decided.

Predicates worth having, and no more than these to start: sustained periods above
a threshold on a named quota type, number of dimensions under pressure, add-ons
held and not held, and subscription age.

**One contract to respect, and an earlier draft of this plan got it backwards.**
That draft said "an offer-driven grant is one-time by nature". It is not: both
worked examples above are *50% for a year*, which is `kind: 'recurring'` — and
`batchEvaluatePromotion` deliberately **skips** recurring promos, because
`grantRecurringPromotions` owns them and batch-granting one would double against
its one-time `dedupeKey`.

So the central offer shape runs on the **periodic** path, not the batch path. The
dedupe key still has to incorporate the offer so a later offer to the same
account can grant, and the recurring path's own 12-month horizon has to be
expressible — a discount that recurs forever is not the offer anybody intended to
make.

## Phase 2 — Offers: the record, the rules, the caps

The `Offer` record — org, **offer type**, SKU or basket, rationale (which signals
fired), amount, the campaign it spends from, status, expiry — plus the rule set,
the frequency cap, the suppression states and the holdout.

**Three offer types, not one** (D4's crossover and Example C):

- **upgrade** — move a tier. The only type a percentage suits (D10), and the only
  one carrying a renewal cliff when discounted (open item 9).
- **pack** — add capacity on one dimension. Structurally hard to discount
  meaningfully, so usually offered at list.
- **compose** — a basket of add-ons sized to the dimensions actually under
  pressure, for an account whose usage has outgrown its tier while its headcount
  has not. Needs no discount, which makes it the cheapest offer to make and the
  safest to get wrong.

The record is the point. It is what the admin surface lists, what the audit trail
references, what D12 retunes from, and what answers "why did this account get
this?" without re-running anything.

The record is the point. It is what the admin surface lists, what the audit trail
references, what the lift measurement counts, and what answers "why did this
account get this?" without re-running anything.

## Phase 3 — Delivery

The offer reaches the account where quota pressure already reaches it.
`threshold-notifier` owns that path — `NOTIFY_EMAIL_PATH`, the notice copy and
the `quota.threshold` webhook payload — and the offer should ride the same
surfaces rather than open a second channel the account has to learn.

**The honest version of the copy names the limit, not the product.** "Your plugin
builds have been at the cap since the 3rd; a pack of 10 is $11.99" is a useful
sentence. "Unlock more with Pro!" is the thing people filter.

**The in-product surfaces are F4 and F5, and F1 gates all of it** — an offer that
cannot be displayed at its discounted price in the flow that accepts it is not
deliverable, whatever the email says.

## Phase 4 — The model, inside the D5 boundary

Rank permitted offers; write one sentence. Reads the profile and the catalogue,
never the grant path.

**Keep account identity out of the prompt.** The model needs the SHAPE of the
usage, not who the account is: pressure by dimension, tier, add-ons held. Send
figures, not names.

## Phase 5 — Extract to `api/offers`

The manifests, the NetworkPolicy, the Istio entry, the scrape target and the
drift-test updates D3 enumerates. Everything above is testable before this.

## Phase 6 — Measurement

Offered versus holdout, on conversion rate and on revenue per account, over a
period long enough that the answer means something. Plus the counters an operator
needs: offers made, suppressed **and why, per reason** (D6), declined, expired,
redeemed, and budget consumed per campaign.

**And the two measures that decide whether the targeting is right rather than
merely active** (D12): offered-SKU against bought-SKU, and time from offer to
conversion. An account that converts to a DIFFERENT SKU is a targeting failure
wearing a conversion win.

## Frontend

An earlier draft of this plan had no frontend section, which for a feature whose
entire value is realised in a UI is a hole rather than an omission. The
redemption and admin surfaces turn out to be largely built — `DiscountRedeem`,
`DiscountDetailDrawer`, `PromotionDetailDrawer`, `MintDiscountModal`,
`CreateCampaignModal`, `CampaignSelect`, `AddonGrid`, `AddonPreviewModal`,
`PlanChangeModal`, `PlanGrid`, `CurrentChargesCard`. What is missing is narrower
and sharper than "build a UI".

**F1 — `PlanChangeModal` cannot show a discount, so the headline offer cannot be
accepted at its stated price.** This is a PREREQUISITE, not an enhancement.
`PlanChangeModal` contains **no** discount references at all, so an account that
accepts a 50%-off Business offer opens the upgrade modal and sees **$249**. Every
worked example in this plan dies at the last click until this is fixed.

**F1b — and the preview is discount-aware only in the DESTRUCTIVE direction.**
`AddonPreviewModal` carries exactly one discount line, and it is a warning that a
change *ends* one: *"Ends your {name} discount — $X/mo off."* It tells an account
what it is about to lose and nothing about what it is about to gain.

That asymmetry is also a pre-flight requirement, not just a display bug: **a
compose basket or an upgrade can TERMINATE a discount the account already
holds.** D9 prices an offer before promising it, and this is part of that price —
an offer that leaves the account worse off net is worse than no offer.

**F2 — The quota card never says what a limit costs, and this is the cheapest
sales feature in the product.** `QuotaCard` shows usage, limit, remaining, status
and a will-breach forecast. It carries no price, no pack and no add-on
information — every `pack`/`price`/`$`/`addon` match in the file is a template
literal inside a `className`.

**The moment someone opens a quota card at 90% is the best sales moment the
product has**, and the card currently says only that they are about to run out.
Adding "a pack of 10 is $11.99" needs **no agent, no campaign, no discount and no
consent**, because it is information rather than an offer. The precedent is
`AIQuotaHint`, which already does exactly this for AI calls: say the cost up
front instead of letting it be discovered as a refusal.

**F3 — The crossover offer has no comparison surface.** `CurrentChargesCard`
knows current charges including add-ons; `PlanGrid` and `SelectablePlanCard` show
plans. Nothing compares an account's ACTUAL spend — packs included — against the
next tier's price, which is the UI for the best offer in this plan (Team plus four
seat packs at $278.96 against Business at $249 for more of everything). Also
information rather than an offer, and also needs no agent.

**F2 and F3 are worth building even if this plan is cancelled**, which is the
strongest argument for doing them first.

**F4 — The redemption model is PULL; the agent needs PUSH.** `DiscountRedeem`
takes a code the account already has; the drawers view one it already holds.
There is no surface where an offer APPEARS unprompted, so the agent currently
mints offers with nowhere to land. **All of it is served by `api/billing`, not by
the agent (D13)** — which is also where a user already goes for anything
commercial. Three parts, and the second matters most:

- an offer surface (a card on the billing page, or a small inbox) that an account
  did not have to go looking for;
- **a decline verb.** Redemption is the only action today, so "never saw it" and
  "said no" are the same row — and that distinction is the single most valuable
  thing D12 measures. D6's lengthened window after a decline is unimplementable
  without it;
- **server-side dismissal.** The frequency cap is server-side; a `localStorage`
  dismissal is per-browser and per-device, so the same offer reappears on a
  laptop. The cap and the UI's memory have to be one record.

**F5 — Do not put offers in `QuotaBanner`, and decide that rather than drift into
it.** It is the obvious push surface: app-wide, already iterating every quota on
the response. It is also the warning channel. Offers placed there compete with
genuine pressure warnings for the same real estate and train people to dismiss
the banner — **degrading the warning channel in order to sell is a bad trade**,
and the quota work already relies on that banner being believed.

**F6 — The compose offer has no UI at all.** `AddonGrid` sells one add-on at a
time (no multi-select, no basket) and `AddonPreviewModal` previews one. Example
C's answer is a basket of three, sized to the dimensions under pressure, with a
combined total and one checkout. None of that exists, and composing it one add-on
at a time asks the account to assemble the offer itself.

**F7 — No comms-preferences surface, but the card to put it on already exists.**
D6 settles the control: `offersEnabled`, account-root, default true, gated on
`billing:manage`. The surface is `QuotaNoticeSettingsCard`, which already renders
the quota-notice `enabled` switch, the webhook URL and the thresholds for the same
account root — so this is one more row on a card that exists rather than a new
settings page.

Two things it must show that a bare toggle would not:

- **the quiet period's state**, because an account that has offers enabled and is
  simply inside its 45 days should see that rather than wonder;
- **the instance-level switch when it is off**, the way `noticesEnabledOnInstance`
  already does — otherwise an operator-disabled feature looks like a broken one.

`api/reporting`'s `POST /public/report-recipients/unsubscribe` remains the
pattern for the per-address path, including its reason for being a POST. But
someone should be able to turn offers off **before** being annoyed, not only
after: an unsubscribe link in an email is the floor, not the feature.

**F8 — No admin visibility into the agent.** A tab on `BillingAdminTabs`, served
by billing (D13) rather than by the agent, beside the manual tooling it already
holds. An automated granter needs its own view: offers made, suppressed and why
per reason, holdout membership, and budget burn-down per campaign. Without it,
"why did this account get 50% off?" has no answer in the UI — which is what the
`Offer` record was for in the first place.

## What is settled, and what is still open

**Settled.** That the existing engine is extended rather than replaced (D2);
that rules decide money and the model does not (D5); that a holdout exists from
the first cycle (D7); that the whole path fails closed (D8); that every offer is
priced through `previewPromotion` before it is promised (D9); and that the
instrument has to match the SKU's price scale, which currently rules capacity
packs out (D10); that discount depth runs inverse to urgency (D11); and that
outcomes are logged and the rules retuned by a person rather than adjusted
online (D12); and that the service is internal only, exposing no public routes,
with billing serving every surface a customer or admin sees (D13).

*Before Phase 1 ships, because they set contracts:*

1. **The `UsageProfile` recompute interval, against the periods it summarises.**
   Flow quotas reset every three days and `cpuCredits` is planned monthly, so a
   profile has to say which window each figure belongs to or "three consecutive
   periods" is not well defined.
2. **The dedupe key's shape (Phase 1).** It has to admit a later offer to the
   same account while still refusing a double grant for the same one.
3. **Which campaign offers spend from.** One standing campaign, or one per offer
   type. The budget, the exclusivity flag and the one-per-account rule all live
   at campaign level, so this decides what can be expressed.

*Product judgements, answerable now but not by reading code:*

4. **The sustained-pressure threshold and period count.** The single number that
   decides whether this feels observant or pushy.
5. **The discount depth per offer type**, inside the existing ceilings and
   following D11's inverse-to-urgency rule. The principle is settled; the numbers
   are not, and a pack at $11.99 does not need the same incentive as a tier step
   of $210.
6. **The post-decline backoff, and the offer expiry.** The base rate is settled
   at one offer per 45 days from send (D6). Two numbers inside it are not: what a
   DECLINE earns on top — long enough to mean something, short enough that a no
   today is not a no forever — and how long an offer should stand, which must be
   under 45 days and at 30 leaves a sensible margin.
7. **Whether a tier offer may ever be made to an account a pack would serve** —
   the overreach question in D4's headroom shape.

8. **The capacity-pack instrument (D10).** A percentage on a $2.49 pack is
   negligible and, scoped to a bundle the account does not hold, is zero. Either
   accept a hand-computed `dollar` amount, or decide that packs are not offered
   until something can grant free UNITS — which is an entitlement, and the
   discount model refuses to grant entitlements by design. Until this is settled,
   the tier offer is the only one worth shipping.
9. **The renewal cliff, and whether a year-long discount should exist at all.**
   Example A saves an account $54/month for a year and then raises it $70/month
   above where it started. If the account grew into the seats it bought,
   `checkEntitlementOvercap` refuses the downgrade until members are removed, so
   the discount converts an account and then makes it feel trapped. The
   alternatives worth weighing: a shallower permanent discount, a shorter window
   with a smaller step, or the no-discount crossover offer (Team plus four packs
   already costs more than Business) which survives renewal because nothing was
   subsidised.

10. **Per-member activity instrumentation (D4 Class 3).** The one piece of new
    data this plan needs, and the disqualifier that keeps the seat offer from
    backfiring. Where the stamp is written and at what granularity are the open
    parts; day-level is almost certainly enough.
11. **The co-occurrence map's SKU assignments (D4).** The pairs are in the plan;
    which SKU each resolves to, and the breadth threshold at which a tier offer
    displaces a pack, are product judgements. This is where the plan is most
    likely to be wrong in a way only real profiles will show.
12. **Whether "small team, large features" deserves a SKU (Example C).** Tiers
    bundle capacity with seats, so an account that needs the second without the
    first has nothing to buy except a basket. If the compose offer converts well,
    that is evidence for a catalogue change made deliberately — and the agent
    should not be left filling the gap with coupons in the meantime.
13. **Where offers appear in-product (F4/F5).** A billing-page card, a small
    inbox, or the app-wide `QuotaBanner`. The banner is the easy answer and the
    wrong one — it is the warning channel, and offers placed there compete with
    genuine pressure warnings. Worth deciding explicitly, because drifting into
    it is the likely default.
14. **The retune cadence (D12).** How often the rules are revisited against the
    outcome log, and who owns the revision. Too frequent and it is online
    learning with extra steps; too rare and the measurement never reaches a rule.

*Measurements, not decisions:*

15. **The holdout size.** 10% is a starting figure; the right one depends on how
   many accounts there are, which decides whether the lift is detectable at all.
   Worth computing before launch rather than defending afterwards.

## Checked and NOT a gap

- **Discount stacking is already bounded.** Interval, volume, combo and coupon
  reductions have a combined ceiling in `config.ts`, so an offer landing on an
  account that already holds a combo cannot compound into a giveaway.
- **Campaign budgets already exist** with `spentCents`, `grantsCount` and
  advisory-spend reconciliation from the ledger, so the agent needs no budget
  machinery of its own.
- **Revocation already works at the right granularity.** Flipping a discount's
  `isActive` invalidates every token minted for it, which is the kill switch an
  automated granter needs and does not have to build.
- **Per-org cost control exists** as `perOrgCapCents` on the promotion.

## What this plan deliberately does not do

- **It does not negotiate.** No conversational surface, no counter-offers. An
  offer is a row with an expiry.
- **It does not do outbound to non-customers.** Every account it touches is
  already subscribed; there is no lead list and no cold contact.
- **It does not let a model set a price or an amount (D5).**
- **It does not send account identity to a model (Phase 4).**
- **It does not change list prices.** Repricing is a catalogue decision with its
  own invariant tests; this spends a discount budget against existing prices.
- **It does not grant entitlements.** Like every discount, an offer grants CENTS
  of usage credit; it cannot hand an account a bundle it does not hold — the
  discount model says so explicitly for `appliesToBundles`. This is why "two
  packs free" is not expressible and why D10 rules capacity-pack offers out for
  now, rather than shipping an instrument worth $59 a year.
- **It does not promise what the stack floor will refuse (D9).** Every offer is
  priced first; an unredeemable offer is suppressed, not sent.
- **It does not replace the admin surface.** `campaigns`, `discounts` and
  `promotions` keep working by hand; this adds an automated caller, not a
  replacement.
- **It does not sell during trouble (D6).** Open incident, failed payment, first
  N days, or holdout — no offer.

## Rough sizing

| Phase | Size | Why |
|---|---|---|
| 0 | Medium | A profile model, a scheduler on the proven `createScheduler` + `leaderLockKey` pattern, and cross-service reads for quota, storage, seats and add-ons. Plus two pieces of groundwork with standalone value: extracting the burn-rate projection out of `QuotaCard.tsx` into api-core, and the per-member activity stamp. The crossover signal ships here and needs neither |
| 1 | Small–Medium | A `usage` block on the conditions, the context widened, and `matchesConditions` extended — plus the dedupe-key decision, and the recurring path rather than the batch path, since a year-long offer is `kind: 'recurring'` |
| 2 | Medium | The `Offer` record, the rule set, frequency caps, suppression states, the holdout, and the `previewPromotion` pre-flight (D9) |
| 3 | Small | Rides `threshold-notifier`'s existing notice and webhook surfaces; the work is copy and the unsubscribe token |
| 4 | Medium | Optional by construction, and must degrade to static priority |
| 5 | Small–Medium | A tenth service across three Kubernetes trees plus docker, NetworkPolicy and a metrics scrape — but NO ingress, auth middleware or route-table entry, since D13 gives it no public surface. Offset by its being the repo's first route-less service, so the manifests have no exact template |
| 6 | Small–Medium | Counters, per-reason suppression, the holdout comparison, and the outcome log D12 retunes from |
| Frontend | Medium | F1 is a PREREQUISITE (`PlanChangeModal` shows no discount, so the offer cannot be accepted at its price). F2 and F3 are standalone wins needing no agent. F4 is the real new surface — push, a decline verb, server-side dismissal. F6 is a basket flow `AddonGrid` has no shape for. F7 and F8 are a settings surface and an admin tab |

## How we would know it worked

Conversion and revenue per account, offered against holdout. Plus the signals
that tell you it is behaving rather than merely running: suppression reasons by
count (a feature suppressing almost everything is misconfigured, not careful),
offers expiring unredeemed, unsubscribe rate, and budget consumed per campaign
against grants made.

**The unsubscribe rate is the one to watch first.** It is the only metric here
that measures whether the account experienced this as useful or as spam, and it
is the one that cannot be fixed later by tuning a threshold.

## Sequencing

**F1 before anything ships to a customer**, because until `PlanChangeModal` can
show a discount, every offer in this plan is a promise the checkout contradicts.
It is also the smallest item in the set.

**Then F2 and F3, which are not really part of this plan at all.** Telling people
what a limit costs on the page where they look at the limit, and showing an
account its real spend against the next tier, are both pure information. They
need no agent, no campaign, no discount and no consent — and if the agent is
never built they are still the right thing to have done.

**The crossover offer first among the offer types, before any of the phases.** It is arithmetic over
the subscription record: no profile, no discount, no campaign, no model, no
consent question that a billing notice does not already raise. It is the cheapest
proof that the premise holds — that there are accounts whose spend already argues
for a tier move — and if there are none, that is worth knowing before Phase 0.

**Then Phase 0, and alone, because the signals are the risky part.** Every rule
in Phase 2 is a function of a profile, so a wrong profile makes every rule wrong
in a way that looks like a rule problem. Build the store, look at real profiles
for a period, and only then write rules against them.

**D7's holdout lands with Phase 2, not after.** It is cheap, and it is
unrecoverable if skipped — a holdout added later cannot measure the launch.

**Phase 3 before Phase 4.** Delivery with deterministic copy is shippable and
measurable; the model is an improvement on a working thing, not a prerequisite
for it. Shipping 4 first would make an AI outage an expansion outage.

**Phase 5 whenever the deployment cost is worth paying.** Nothing above needs it,
and running Phases 0–3 as a billing scheduler is the cheaper place to discover
that a rule is wrong.
