---
layout: default
title: Billing Discounts
---

# Billing Discounts

## Overview

This is the reference for **operator-granted discounts** — the price-only reductions a system admin mints, issues, and an account redeems, all realized as Stripe **customer-balance usage credits** rather than provider coupons. It covers the discount-code format, the mint → issue → redeem lifecycle, per-provider handling (Stripe in-app vs. AWS Marketplace private offers), and the admin/self-service API. For the automatic, composition-based credits earned from add-on [combos](billing-bundles.md#combo-pricing), see the note under [Everything is a usage credit](#everything-is-a-usage-credit).

Discounts are **price-only** adjustments an operator grants on top of an account's subscription — a temporary price reduction (one-time or recurring) or a standing balance, both realized as a **usage credit** that offsets future costs. They never change entitlements, quotas, or tier; they only change the bill, and they are **never forwarded to the provider as a coupon** — billing owns the reduction. For the caps and tiers themselves, see [feature tiers](README.md#feature-tiers) and [add-on bundles](billing-bundles.md).

Discounts are controlled by `BILLING_DISCOUNTS_ENABLED` (**on by default**; set `false` to hide the surface). On **Stripe** they realize as a customer-balance credit. On **AWS Marketplace** — which has no customer-balance primitive — they realize by *withholding reported metered usage*, active only when `BILLING_METERING_ENABLED` is also on (see [Applying a discount by provider](#applying-a-discount-by-provider)); otherwise Marketplace accounts are rejected.

---

## Discount codes

Every discount is authored in a compact, human-readable form and issued (when handed to a customer) as an opaque, unforgeable token.

**Authoring form** — what an operator types when minting:

```
value : unit : kind [ : campaign ]
```

| Field | Values | Notes |
|-------|--------|-------|
| `value` | positive integer | percent points, or **whole dollars** (stored as cents) |
| `unit` | `dollar` \| `percent` | aliases `$` / `%` |
| `kind` | `onetime` \| `recurring` \| `credit` | see below |
| `campaign` | optional label | e.g. `summer24`, for reporting |

Examples: `50:percent:onetime` · `25:dollar:recurring` · `100:dollar:credit` · `50:percent:onetime:summer24`

**Issued token** — a customer never sees the authoring form. Mode-B issuance seals the discount into an opaque **AES-256-GCM** token (`v1.<base64url>`), non-deterministic (a fresh token every time) and **unforgeable**: only a holder of the signing key can mint one that decodes, so a guessed or hand-crafted string is rejected. Signing keys are versioned (`BILLING_DISCOUNT_KEYS`) so they can be rotated — the highest version mints, older keys still decode.

---

## Everything is a usage credit

A discount is **never** forwarded to the provider as a coupon object. Every kind resolves to a **usage credit** — a temporary price reduction billing owns, banked as a balance and applied against future costs. The only difference between the kinds is *how much* and *how often* the credit is granted:

| Kind | Grant | Realized as |
|------|-------|-------------|
| `onetime` | a one-time credit = the reduction (percent-of-plan or dollars), granted once | a usage credit consumed by the next invoice |
| `recurring` | the reduction re-granted **every period** (a standing rule) until removed | a usage credit topped up each cycle |
| `credit` | a one-time credit of the value, drawn down over time | a usage-credit balance |

The credit is realized on the customer's **balance** at the provider (Stripe posts a negative customer-balance transaction, applied to upcoming invoices) — there is no coupon and no per-subscription discount object. A `percent` discount is resolved to dollars from the plan price at grant time, so a `recurring` percent discount **tracks plan changes** — each period's credit is recomputed from the then-current price. A subscription may hold **one standing `recurring` rule** at a time; credits accumulate freely.

> **Combo discounts** are a second, automatic source of usage credits: holding a qualifying set of add-ons (e.g. the **Analytics Suite** or **Team Growth Bundle**) grants a recurring credit for the bundled saving, using the same balance mechanism. They are composition-based rather than operator-granted — see [Combo pricing](billing-bundles.md#combo-pricing).

---

## Applying a discount by provider

How a discount actually reaches an account depends on the billing provider. **The in-app discount surface described here is Stripe-only**; AWS Marketplace discounts are handled on the AWS side.

### Stripe — in-app discounts (fully supported)

This is the flow this document describes end to end:

1. **Mint** the discount (system admin) — `POST /billing/admin/discounts` with `value:unit:kind`.
2. **Deliver** it — either **Mode A** (`/apply` a direct grant to `{ targetOrgId }`) or **Mode B** (`/token`, hand the customer an opaque token or public alias).
3. **Redeem** — an admin applies it, or the account self-redeems on the billing page (`billing:manage`).
4. **Realize** — billing posts a negative **customer-balance** transaction at Stripe; the credit offsets upcoming invoices automatically, and a `recurring` rule re-grants each period.

Nothing is sent to Stripe as a coupon — billing owns the reduction and only mirrors it to the customer balance.

### AWS Marketplace — private offers (handled in AWS, not in-app)

Marketplace has no customer-balance primitive, so in-app credits are realized differently: by **withholding reported metered usage**. When both `BILLING_DISCOUNTS_ENABLED` and `BILLING_METERING_ENABLED` are on, the provider reports `usageCreditSupport: 'metered'` and the same mint → redeem flow applies to Marketplace accounts; a banked credit is drawn down on the metering cycle. When metering is off, the provider reports `usageCreditSupport: 'none'` and the routes reject these accounts (`DISCOUNTS_UNSUPPORTED`, HTTP 409) — a credit is never accepted unless the mechanism that realizes it is running (no banking without realization).

**How metered realization works** (per metering cycle, gated + default-off):

1. **Re-grant** — once per billing period (`YYYY` annual / `YYYY-MM` monthly), the standing recurring discount + any active combo credits are re-granted onto the local balance (Marketplace has no invoices to drive Stripe's reconciler, so the cycle drives it).
2. **Withhold** — for each metered add-on dimension, the cycle reports `units − withheld` to `BatchMeterUsage`, where the withheld units' value (at the dimension's configured price, `AWS_MARKETPLACE_DIMENSION_PRICE_MAP`, cents per unit per cycle) is drawn from the balance. Whole units only; the remainder carries forward.
3. **Consume** — the balance is drawn down **once per dedupe-hour**, only when AWS accepted every record (`unprocessed === 0`), emitting `credit_consumed` (and `credit_exhausted` at zero). Multi-pod safe via atomic conditional updates.

Set **`BILLING_METERING_DRAWDOWN_DRYRUN=true`** to validate first: the cycle logs the intended withholding but reports full quantities and leaves the balance untouched.

**Known limitation.** Withholding offsets **metered add-on usage only** — never the base plan contract line. So a recurring *plan-percent* discount on an account with little/no metered add-on usage realizes only partially (or not at all); the un-drawable surplus is surfaced via a warn + `billing_marketplace_credit_unrealizable_total` metric, not silently lost. For plan-level or contract pricing, use an **AWS Marketplace private offer**:

1. In the **AWS Marketplace Management Portal**, the seller creates a private offer for the buyer's AWS account — a custom price, term, and/or payment schedule against the same product.
2. The buyer **accepts** the offer in AWS Marketplace; the new pricing is billed by AWS directly.
3. The entitlement flows into the platform through the existing Marketplace subscription path (SNS + `ResolveCustomer`) — **the discount lives entirely in AWS**, so no in-app discount record is created and it doesn't surface as a `discount`/`credit` line in the [billing dashboard](#availability) (which reads the local ledger, not AWS pricing).

---

## Who grants a discount, and how

**Generation** (mint the record) and **issuance** (deliver it) are separate steps, both **system-admin only**.

- **Mode A — direct grant.** The operator applies a discount straight onto a target account's subscription. The customer never sees a token; the discount simply appears on their bill. Best for sales/support grants.
- **Mode B — distributed token.** The operator issues an opaque token (or a short public **alias** like `SUMMER50`) and delivers it out-of-band (email, landing page). The customer redeems it themselves. Best for promos.

**Redemption** happens two ways:

- **System-targeted** — an admin applies a discount to a specified account (Mode A, or Mode B on the account's behalf).
- **Self-service** — an account admin with `billing:manage` pastes a token/alias on their own billing page. They can only ever discount their own account.

A discount bound to a `targetOrgId` is redeemable only by that account; an untargeted (public) discount is redeemable by anyone, subject to `maxRedemptions`, `redeemBy`, and tier restrictions.

### Re-issue & revoke

Because a token only seals the discount id, **one discount can back many tokens** — re-issuing mints a fresh string against the same record and shared redemption counter. **Revoking** (`isActive: false`) invalidates **every** token for that discount at once, since redemption always validates the live record, not the string. Revoking does **not** strip a discount already applied to a subscription — remove those explicitly.

---

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

Every mutation writes a local `billing_events` row and mirrors to the central [audit trail](audit-events.md) (`billing.discount.generate` / `.issue` / `.apply` / `.remove` / `.revoke`, plus `billing.credit.consumed` / `.exhausted` and `billing.combo.expired` for usage-credit realization), attributing both the acting party and the affected account. **Tokens, signing keys, and aliases are never logged or audited** — only the discount id, kind, and value. An account can review its own credit movement via `GET /billing/events` (`billing:read`).

---

## Security & governance

- **Unforgeable codes.** GCM authentication means a discount is only redeemable if a live record exists; a guessed/forged token is rejected. Targeted discounts are additionally bound to one account.
- **Mint ceilings.** `BILLING_DISCOUNT_MAX_PERCENT` / `BILLING_DISCOUNT_MAX_CENTS` cap the magnitude an operator can mint.
- **Reserve-before-apply.** A redemption atomically claims a slot under `maxRedemptions` before mutating the subscription, so concurrent redemptions can't exceed the cap; a failed apply compensates the reservation.
- **One recurring rule, de-duplicated.** A second standing recurring discount, or re-redeeming an already-redeemed discount, is rejected.
- **Key loss** makes previously issued Mode-B tokens undecodable, but discounts already applied to subscriptions are unaffected. Provision `BILLING_DISCOUNT_KEYS` as a sealed secret.

---

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `BILLING_DISCOUNTS_ENABLED` | `true` | Master switch — set `false` to 404 the discount routes |
| `BILLING_DISCOUNT_KEYS` | — | **Secret.** Versioned AES-256-GCM keys `v1:<base64-32B>,v2:…` |
| `BILLING_DISCOUNT_MAX_PERCENT` | `100` | Ceiling on a percent discount |
| `BILLING_DISCOUNT_MAX_CENTS` | `10000000` | Ceiling on a dollar/credit discount, in cents |

See [Environment Variables → Billing](environment-variables.md#billing).

---

## Availability

- **Stripe-billed accounts** — the full in-app discount flow above (mint, issue, redeem, self-service), realized as customer-balance usage credits.
- **Billing dashboard** — the account's **Billing** page summarizes the period as **gross billed → discounts + usage credits → net**, with a per-period bar chart and an invoice table showing the discount/credit applied to each invoice (`GET /billing/summary`). This is where an account sees the effect of its discounts.
- **AWS Marketplace-billed accounts** — the in-app discount flow works when `BILLING_METERING_ENABLED` is on (credits realize by **withholding metered usage**, priced via `AWS_MARKETPLACE_DIMENSION_PRICE_MAP`); default-off, so enable + validate with `BILLING_METERING_DRAWDOWN_DRYRUN` first. Withholding offsets metered add-on usage only — for plan-level/contract pricing use [AWS Marketplace private offers](#applying-a-discount-by-provider).
