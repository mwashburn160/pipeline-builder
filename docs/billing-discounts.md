---
layout: default
title: Billing Discounts
---

<!--
Copyright 2026 Pipeline Builder Contributors
SPDX-License-Identifier: Apache-2.0
-->

# Billing Discounts

**Price-only** adjustments an operator grants on top of an account's subscription: a temporary reduction (one-time or recurring) or a standing balance, both realized as a **usage credit** that offsets future costs.

## Highlights

- **Everything is a usage credit.** Nothing is ever forwarded to the provider as a coupon — billing owns the reduction and only mirrors it to the customer balance.
- **Discounts never change entitlements, quotas or tier.** They change the bill and nothing else.
- **Minting and issuing are separate steps**, both system-admin only. Redemption is either admin-targeted or self-service on the account's own billing page.
- **An issued token is opaque and unforgeable** (AES-256-GCM, `v1.<base64url>`, fresh every time). A guessed or hand-crafted string is rejected.
- **One discount can back many tokens**, because a token only seals the discount id. Revoking the record invalidates every token at once.
- **A recurring percent discount tracks plan changes** — each period's credit is recomputed from the then-current price.
- **AWS Marketplace has no customer balance**, so credits realize by *withholding reported metered usage* — and only when metering is on. A credit is never banked unless the mechanism that realizes it is running.
- **Marketplace withholding offsets metered add-on usage only**, never the base plan line. The un-drawable surplus is surfaced as a metric, not silently lost.

## Overview

This is the reference for **operator-granted** discounts: the code format, the mint → issue → redeem lifecycle, per-provider handling, promotions and referrals, and the admin and self-service API.

Written for operators minting discounts and for admins redeeming them. Two things it is *not* about: the caps and tiers themselves (see [feature tiers](README.md#feature-tiers) and [add-on bundles](billing-bundles.md)), and the automatic composition-based credits earned from add-on [combos](billing-bundles.md#combo-pricing) — those share the same credit machinery but are not operator-granted.

## How it works

1. **Mint** — a system admin creates the discount record from a `value:unit:kind` string. Ceilings apply.
2. **Deliver** — either **Mode A**, a direct grant onto a target account, or **Mode B**, an opaque token or short public alias handed out of band.
3. **Redeem** — an admin applies it to a named account, or an account admin with `billing:manage` pastes the token on their own billing page.
4. **Realize** — the reduction is banked as a balance and drawn against future costs. On Stripe that is a negative customer-balance transaction; on Marketplace it is withheld metered usage.
5. **Re-grant** — a `recurring` rule tops the credit up every period until it is removed.

A subscription may hold **one standing `recurring` rule** at a time; credits themselves accumulate freely.

## Configuration

1. **Leave discounts on, or turn them off.** `BILLING_DISCOUNTS_ENABLED` is **on by default**; set `false` to 404 the routes and hide the surface.
2. **Provision the signing keys** as a sealed secret. `BILLING_DISCOUNT_KEYS` holds versioned AES-256-GCM keys (`v1:<base64-32B>,v2:…`); the highest version mints and older keys still decode, so they can be rotated.
3. **Set the mint ceilings** to bound what any single operator can grant.
4. **On AWS Marketplace, decide about metering.** In-app credits only work with `BILLING_METERING_ENABLED` on. Validate first with `BILLING_METERING_DRAWDOWN_DRYRUN=true`, which logs the intended withholding but reports full quantities and leaves the balance untouched.
5. **Enable promotions if you want auto-grants.** `BILLING_PROMOTIONS_ENABLED` has the same opt-out default, and additionally requires `BILLING_DISCOUNTS_ENABLED` — discounts off means promotions off.

| Variable | Default | Description |
|----------|---------|-------------|
| `BILLING_DISCOUNTS_ENABLED` | `true` | Master switch — set `false` to 404 the discount routes |
| `BILLING_DISCOUNT_KEYS` | — | **Secret.** Versioned AES-256-GCM keys `v1:<base64-32B>,v2:…` |
| `BILLING_DISCOUNT_MAX_PERCENT` | `100` | Ceiling on a percent discount |
| `BILLING_DISCOUNT_MAX_CENTS` | `10000000` | Ceiling on a dollar/credit discount, in cents |
| `BILLING_PROMOTIONS_ENABLED` | `true` | Auto-granting promotions; requires discounts enabled |
| `BILLING_METERING_ENABLED` | off | Required for Marketplace credit realization |
| `BILLING_METERING_DRAWDOWN_DRYRUN` | `false` | Log intended withholding without changing anything |
| `BILLING_PROMOTION_BACKFILL_INTERVAL_MS` | — | Backfill cron cadence (leader-locked) |
| `BILLING_PROMOTION_CLAWBACK_WINDOW_MS` | 7 days | Cancel-within window that reverses a promo grant |

See [Environment Variables → Billing](environment-variables.md#billing).

## Discount codes

Every discount is authored in a compact, human-readable form and issued — when handed to a customer — as an opaque, unforgeable token.

### Authoring form

What an operator types when minting:

```
value : unit : kind [ : campaign ]
```

| Field | Values | Notes |
|-------|--------|-------|
| `value` | positive integer | percent points, or **whole dollars** (stored as cents) |
| `unit` | `dollar` \| `percent` | aliases `$` / `%` |
| `kind` | `onetime` \| `recurring` \| `credit` | see [the kinds](#everything-is-a-usage-credit) |
| `campaign` | optional label | e.g. `summer24`, for reporting |

Examples: `50:percent:onetime` · `25:dollar:recurring` · `100:dollar:credit` · `50:percent:onetime:summer24`

### Issued token

A customer never sees the authoring form. Mode-B issuance seals the discount into an opaque **AES-256-GCM** token (`v1.<base64url>`), non-deterministic — a fresh token every time — and **unforgeable**: only a holder of the signing key can mint one that decodes, so a guessed or hand-crafted string is rejected.

## Everything is a usage credit

A discount is **never** forwarded to the provider as a coupon object. Every kind resolves to a **usage credit** that billing owns, banked as a balance and applied against future costs. The only difference between the kinds is *how much* and *how often* the credit is granted:

| Kind | Grant | Realized as |
|------|-------|-------------|
| `onetime` | a one-time credit = the reduction (percent-of-plan or dollars), granted once | a usage credit consumed by the next invoice |
| `recurring` | the reduction re-granted **every period** (a standing rule) until removed | a usage credit topped up each cycle |
| `credit` | a one-time credit of the value, drawn down over time | a usage-credit balance |

The credit is realized on the customer's **balance** at the provider — Stripe posts a negative customer-balance transaction, applied to upcoming invoices. There is no coupon and no per-subscription discount object.

A `percent` discount is resolved to dollars from the plan price at grant time, so a `recurring` percent discount **tracks plan changes**: each period's credit is recomputed from the then-current price.

> **Combo discounts** are a second, automatic source of usage credits: holding a qualifying set of add-ons (for example the **Analytics Suite** or **Team Growth Bundle**) grants a recurring credit for the bundled saving, using the same balance mechanism. They are composition-based rather than operator-granted — see [Combo pricing](billing-bundles.md#combo-pricing).

## Applying a discount by provider

How a discount reaches an account depends on the billing provider. **The in-app discount surface described here is Stripe-only**; AWS Marketplace plan-level discounts are handled on the AWS side.

### Stripe — in-app discounts (fully supported)

1. **Mint** the discount (system admin) — `POST /billing/admin/discounts` with `value:unit:kind`.
2. **Deliver** it — **Mode A** (`/apply`, a direct grant to `{ targetOrgId }`) or **Mode B** (`/token`, hand the customer an opaque token or public alias).
3. **Redeem** — an admin applies it, or the account self-redeems on the billing page (`billing:manage`).
4. **Realize** — billing posts a negative **customer-balance** transaction at Stripe; the credit offsets upcoming invoices automatically, and a `recurring` rule re-grants each period.

Nothing is sent to Stripe as a coupon.

### AWS Marketplace — withheld metered usage

Marketplace has no customer-balance primitive, so in-app credits are realized by **withholding reported metered usage**.

When both `BILLING_DISCOUNTS_ENABLED` and `BILLING_METERING_ENABLED` are on, the provider reports `usageCreditSupport: 'metered'` and the same mint → redeem flow applies to Marketplace accounts; a banked credit is drawn down on the metering cycle.

When metering is off, the provider reports `usageCreditSupport: 'none'` and the routes reject these accounts (`DISCOUNTS_UNSUPPORTED`, HTTP 409). A credit is never accepted unless the mechanism that realizes it is running — no banking without realization.

**Per metering cycle** (gated, default-off):

1. **Re-grant** — once per billing period (`YYYY` annual / `YYYY-MM` monthly), the standing recurring discount plus any active combo credits are re-granted onto the local balance. Marketplace has no invoices to drive Stripe's reconciler, so the cycle drives it.
2. **Withhold** — for each metered add-on dimension, the cycle reports `units − withheld` to `BatchMeterUsage`, where the withheld units' value (at the dimension's configured price, `AWS_MARKETPLACE_DIMENSION_PRICE_MAP`, cents per unit per cycle) is drawn from the balance. Whole units only; the remainder carries forward.
3. **Consume** — the balance is drawn down **once per dedupe-hour**, only when AWS accepted every record (`unprocessed === 0`), emitting `credit_consumed` and `credit_exhausted` at zero. Multi-pod safe via atomic conditional updates.

**Known limitation.** Withholding offsets **metered add-on usage only** — never the base plan contract line. So a recurring *plan-percent* discount on an account with little or no metered add-on usage realizes only partially, or not at all. The un-drawable surplus is surfaced via a warn plus the `billing_marketplace_credit_unrealizable_total` metric rather than silently lost.

### AWS Marketplace — private offers (handled in AWS, not in-app)

For plan-level or contract pricing, use an **AWS Marketplace private offer**:

1. In the **AWS Marketplace Management Portal**, the seller creates a private offer for the buyer's AWS account — a custom price, term and/or payment schedule against the same product.
2. The buyer **accepts** the offer in AWS Marketplace; the new pricing is billed by AWS directly.
3. The entitlement flows into the platform through the existing Marketplace subscription path (SNS + `ResolveCustomer`).

**The discount lives entirely in AWS**, so no in-app discount record is created and it does not surface as a `discount`/`credit` line in the [billing dashboard](#availability), which reads the local ledger rather than AWS pricing.

## Who grants a discount, and how

**Generation** (mint the record) and **issuance** (deliver it) are separate steps, both **system-admin only**.

| Mode | How | Best for |
|---|---|---|
| **A — direct grant** | The operator applies the discount straight onto a target account's subscription. The customer never sees a token; the discount simply appears on their bill. | Sales and support grants |
| **B — distributed token** | The operator issues an opaque token, or a short public **alias** like `SUMMER50`, and delivers it out of band (email, landing page). The customer redeems it themselves. | Promos |

**Redemption** happens two ways:

- **System-targeted** — an admin applies a discount to a specified account (Mode A, or Mode B on the account's behalf).
- **Self-service** — an account admin with `billing:manage` pastes a token or alias on their own billing page. They can only ever discount their own account.

A discount bound to a `targetOrgId` is redeemable only by that account. An untargeted (public) discount is redeemable by anyone, subject to `maxRedemptions`, `redeemBy` and tier restrictions.

### Re-issue and revoke

Because a token only seals the discount id, **one discount can back many tokens** — re-issuing mints a fresh string against the same record and shared redemption counter.

**Revoking** (`isActive: false`) invalidates **every** token for that discount at once, since redemption always validates the live record rather than the string. Revoking does **not** strip a discount already applied to a subscription — remove those explicitly.

## Promotions

A **promotion** is the marketing counterpart to a discount. Where a discount is *redeemed* (a code someone enters) or *manually granted*, a promotion **auto-grants a usage credit when an org hits a trigger**, bounded by a campaign budget.

It is a grant *source*, reusing the same usage-credit machinery (`creditBalanceCents` / `creditLedger`, drawn down on the invoice or by Marketplace metered withholding), so there is no new realization path.

### Triggers

A promotion fires on a lifecycle event evaluated against the org's subscription:

| Trigger | For |
|---|---|
| `subscription_created` | Signup / first-subscription campaigns (with `firstSubscriptionOnly`) |
| `plan_change` | Upgrade / conversion campaigns |
| `manual` | Admin-only; granted via `POST /admin/promotions/:id/grant` |
| `referral` | Two-sided — see [Referrals](#referrals) |

**Eligibility** (`trigger.conditions`, all must match): `tiers`, `intervals`, `firstSubscriptionOnly`. Plus an active window (`startsAt` / `endsAt`).

### Budget and safety

Each grant **atomically reserves** from `budgetCents` (a guarded `$inc`), then applies the credit **idempotently** per `(promotion, org)` via a `creditLedger.dedupeKey`. Any failure after reservation **compensates** (`$inc -cents`) — so concurrent triggers can never overspend, and the bias is always under-spend.

`spentCents` / `grantsCount` are a reconciled **advisory cache**; the ledger (Σ `promo:<id>` entries) is the source of truth. `GET /admin/promotions/:id/spend` returns both and their drift.

A promotion **never grants when the provider can't realize a usage credit** (`usageCreditSupport === 'none'`) — it warns instead of banking an unrealizable credit. `perOrgCapCents` clamps a single grant; `maxGrants` caps total grants.

### Value and cadence

`unit: 'dollar'` (cents) or `'percent'` (percent of the current plan price, resolved at grant time).

`kind: 'onetime'` grants once. **`kind: 'recurring'`** re-grants each billing period from the periodic reconcile/metering path with **period-keyed** idempotency, so a redelivered invoice never double-grants. It stops when the promo is revoked, out of window, over budget, or the org is no longer eligible.

### Batch activation and backfill

`POST /admin/promotions/:id/activate` grants across the **existing** eligible base now — idempotent per org, budget-bounded, with skips logged rather than silent.

A **backfill cron** (`BILLING_PROMOTION_BACKFILL_INTERVAL_MS`, leader-locked) periodically does the same for every active promo, so a grant dropped by a transient failure, or a campaign activated after an org's signup, still lands.

### Clawback

A grant is reversed — ledger row pulled, balance reduced, budget released, `promotion_clawback` emitted — if the subscription **cancels within the clawback window** (`BILLING_PROMOTION_CLAWBACK_WINDOW_MS`, default 7 days). This defuses signup-grab-churn.

**Revoking** a promotion (`isActive: false`, or `DELETE`) stops future auto-grants; credits granted earlier and outside the clawback window stay.

### Referrals

A `referral` promotion is **two-sided**. A new org subscribes with a **referral code** — the referrer's org id — via `referralCode` on `POST /billing/subscriptions`:

- The **referee** is credited immediately (`value`), and a pending `Referral` is recorded.
- The **referrer** is credited only once the referee **qualifies**, meaning its *first paid invoice*, with `referrerValue` (or the same as the referee if unset). Gating on first payment defeats fake-referral farming.

Guards: no self-referral; a referee is referred **at most once** (unique); the referrer must be a real subscribed org; and both grants flow through the shared budget and idempotency machinery — referee keyed per org, referrer keyed per pair. A referral whose referrer grant can't be funded still marks qualified, so it won't retry forever.

## API

All routes are under `/billing` and gated by `BILLING_DISCOUNTS_ENABLED`.

| Method | Path | Gate | Purpose |
|--------|------|------|---------|
| `POST` | `/admin/discounts` | system admin | Mint a discount (ceiling-checked) |
| `POST` | `/admin/discounts/:id/token` | system admin | Mode B — issue / re-issue an opaque token |
| `POST` | `/admin/discounts/:id/apply` | system admin | Mode A — direct grant to `{ targetOrgId }` |
| `GET` | `/admin/discounts` · `/:id` | system admin | List (filter by campaign/active/target) / inspect |
| `PUT` · `DELETE` | `/admin/discounts/:id` | system admin | Edit / **revoke** |
| `POST` | `/subscriptions/:id/discounts` | `billing:manage` | Self-service redeem a token or alias |
| `DELETE` | `/subscriptions/:id/discounts/:discountId` | `billing:manage` | Stop a standing recurring discount (granted credits persist) |
| `GET` | `/events` | `billing:read` | The caller's own billing events — credit applied/consumed/exhausted, discounts, combos (own org only) |

Every mutation writes a local `billing_events` row and mirrors to the central [audit trail](audit-events.md): `billing.discount.generate` / `.issue` / `.apply` / `.remove` / `.revoke`, plus `billing.credit.consumed` / `.exhausted` and `billing.combo.expired` for usage-credit realization, attributing both the acting party and the affected account.

**Tokens, signing keys and aliases are never logged or audited** — only the discount id, kind and value. An account can review its own credit movement via `GET /billing/events` (`billing:read`).

## Security and governance

- **Unforgeable codes.** GCM authentication means a discount is only redeemable if a live record exists; a guessed or forged token is rejected. Targeted discounts are additionally bound to one account.
- **Mint ceilings.** `BILLING_DISCOUNT_MAX_PERCENT` / `BILLING_DISCOUNT_MAX_CENTS` cap the magnitude an operator can mint.
- **Reserve-before-apply.** A redemption atomically claims a slot under `maxRedemptions` before mutating the subscription, so concurrent redemptions can't exceed the cap; a failed apply compensates the reservation.
- **One recurring rule, de-duplicated.** A second standing recurring discount, or re-redeeming an already-redeemed discount, is rejected.
- **Key loss** makes previously issued Mode-B tokens undecodable, but discounts already applied to subscriptions are unaffected. Provision `BILLING_DISCOUNT_KEYS` as a sealed secret.

## Availability

- **Stripe-billed accounts** — the full in-app flow above, realized as customer-balance usage credits.
- **AWS Marketplace-billed accounts** — the in-app flow works when `BILLING_METERING_ENABLED` is on, with credits realized by withholding metered usage, priced via `AWS_MARKETPLACE_DIMENSION_PRICE_MAP`. Default-off, so enable and validate with `BILLING_METERING_DRAWDOWN_DRYRUN` first. Withholding offsets metered add-on usage only — for plan-level or contract pricing use [private offers](#aws-marketplace--private-offers-handled-in-aws-not-in-app).
- **Billing dashboard** — the account's **Billing** page summarizes the period as **gross billed → discounts + usage credits → net**, with a per-period bar chart and an invoice table showing the discount or credit applied to each invoice (`GET /billing/summary`). This is where an account sees the effect of its discounts.

## Related

- [Billing Bundles](billing-bundles.md) — add-on packs and the automatic combo credits
- [Billing Providers](billing-providers.md) — Stripe and AWS Marketplace setup
- [Feature Tiers](README.md#feature-tiers) — what a plan includes before any discount
- [Audit Events](audit-events.md) — the actions every discount mutation records
- [Environment Variables → Billing](environment-variables.md#billing)
