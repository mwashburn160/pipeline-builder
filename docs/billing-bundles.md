---
layout: default
title: Billing Add-on Bundles
---

# Billing Add-on Bundles

## Overview

This is the operator and admin reference for **add-on bundles** — how they stack on a subscription tier, what each bundle grants, the **combo discounts** (Analytics Suite, Team Growth Bundle), how caps **pool across teams**, and the endpoints and env overrides for managing them. The governing rule is that an account's **effective limit = tier baseline + Σ(bundle grant × quantity)**, computed by billing and synced to the enforcing services. It's written for org **admins/owners** buying extra capacity and operators configuring the catalog. For the tier baselines bundles build on, see [feature tiers](README.md#feature-tiers).

## Process overview

1. **Enable** — an operator sets `BILLING_BUNDLES_ENABLED=true` (self-service purchase is disabled under AWS Marketplace).
2. **Preview** — an admin lists bundles (`GET /bundles`) and previews a change (`POST /subscriptions/:id/addons/preview`) to confirm the new effective limits before committing.
3. **Purchase** — add or change an add-on (`POST /subscriptions/:id/addons`); stackable packs can be bought in quantity.
4. **Compute** — billing recomputes `effective[quota] = tierBase + Σ(grant × quantity)` and applies any qualifying **combo** as a recurring usage credit (best-combo packing, never double-discounted).
5. **Sync & pool** — the effective entitlement is pushed to the quota service (quotas) and platform service (seats, purchased features), pooled at the **account root** across every team.

Add-on bundles are purchasable packs that stack **on top of** an account's subscription tier to raise its caps or unlock features — without moving the whole account to a higher tier. A team that needs a few more seats or one more pipeline buys the matching pack instead of jumping from Pro to Enterprise.

Bundles complement the [feature tiers](README.md#feature-tiers): the tier sets the baseline, bundles adjust it. For the org/team model the caps apply to, see [Organization Benefits → Organizations, Teams & Billing](organization-benefits.md#organizations-teams--billing).

---

## How stacking works

An account's **effective limit** for any quota is its tier baseline plus the sum of every applied bundle's grant, scaled by quantity:

```
effective[quota] = tierBase[quota] + Σ (bundle.grant[quota] × quantity)
```

- **Stackable bundles** can be purchased in quantity — buy the Seat Pack ×3 for +15 seats.
- An **unlimited** baseline (`-1`, e.g. Team/Enterprise `apiCalls`) stays unlimited — bundles never shrink it.
- **Feature bundles** (Audit Log, SSO) add a capability rather than a number; they are not stackable.
- Effective limits are **pooled at the account root** and shared across the root's teams — see [pooling](#pooling-across-teams).

Billing computes the effective entitlement and syncs it to the enforcing services: the nine tracked quota types go to the **quota service**, `seats` and purchased features (`audit_log`, `sso`) go to the **platform service** (`PUT /organization/{orgId}/seat-limit`), and the effective **retention** windows go to the **reporting service** (`PUT /api/reports/retention-sync/{orgId}`, writing `dora_settings`). All target the account root. (Retention is not one of the nine flow quotas — it reuses the tier-baseline + bundle-grant math but rides its own reporting sync leg.)

---

## The bundles

Prices are the built-in defaults (USD); annual defaults to 10× monthly. Every price, grant, and eligible-tier list is env-overridable (see [Overrides](#configuration--overrides)).

| Bundle | Grant | Monthly | Annual | Available to | Stackable |
|--------|-------|--------:|-------:|--------------|:---------:|
| **Seat Pack** | +5 member seats | $25 | $250 | all tiers | ✅ |
| **Pipeline Pack** | +10 pipelines | $15 | $150 | all tiers | ✅ |
| **Plugin Pack** | +100 plugins | $15 | $150 | all tiers | ✅ |
| **API Pack** | +1,000,000 API calls / period | $20 | $200 | all tiers | ✅ |
| **AI Pack** | +5,000 AI calls / period | $75 | $750 | all tiers | ✅ |
| **Storage Pack** | +50 GB registry storage | $25 | $250 | all tiers | ✅ |
| **Standard Retention Pack** | +90 days standard pipeline-event retention | $15 | $150 | all tiers | ✅ |
| **DORA History Pack** | +365 days DORA history **and** +365 days on the per-org report-query window | $30 | $300 | all tiers | ✅ |
| **Audit Log** | unlocks the `audit_log` feature | $20 | $200 | Pro | ❌ |
| **SSO / IdP** | unlocks `sso` + up to 5 IdP configs | $40 | $400 | Pro | ❌ |
| **Advanced Reporting (DORA)** | unlocks the `advanced_reporting` feature | $30 | $300 | Developer, Pro, Team | ❌ |
| **Team Usage Analytics** | unlocks the `team_usage_analytics` feature (per-team usage breakdown across the org → team subtree) | $30 | $300 | Pro, Team | ❌ |

Notes:
- **API Pack** is available on every tier, since all tiers now have a finite API-call cap (Team 2M, Enterprise 10M) that can be topped up.
- **Retention is a tier-aware, bundle-extendable entitlement.** Each tier carries a baseline reporting-retention window — paid tiers default to **30 days** for standard pipeline events and **180 days** for DORA source, while the **unlimited** tier is **unlimited retention** (`-1`, history is never swept). The two retention packs stack the same way every other pack does — effective retention = tier baseline + Σ(pack grant × quantity). Billing computes that effective window and **syncs it to the reporting service** (`dora_settings.event_retention_days` / `dora_retention_days`), a sync leg alongside quotas → quota service and seats/features → platform. Buy **Standard Retention Pack ×2** for +180 days of standard-event history.
- The **DORA History Pack** also widens the per-org report-query window (which now tracks retention, capped at an absolute 730 days) — so a pack holder can actually query the extended range, not just retain the raw rows. It only does anything useful alongside **Advanced Reporting (DORA)**, which is included on Enterprise and an add-on on Developer/Pro/Team.
- **Audit Log**, **SSO**, **Advanced Reporting**, and **Team Usage Analytics** are the "buy up a capability without changing tier" path. Each is standard from a given tier up (Audit Log and SSO from Team; Advanced Reporting and Team Usage Analytics from Enterprise), and the bundle lets a lower tier add it à la carte — so the add-on is offered only to the tiers that don't already include it (Audit Log/SSO → Pro; Advanced Reporting → Developer/Pro/Team; Team Usage Analytics → Pro/Team, since Developer has no teams to break down).

---

## Combo pricing

Some add-ons are cheaper bought together. When an account holds **every** member of a combo (each at ≥ its minimum quantity), the set is billed at a reduced **combined price** instead of the sum of the members — and the difference is realized as a recurring **usage credit** (never a provider coupon), consistent with the [discount model](billing-discounts.md).

| Combo | Members | Buy separately | Together | You save |
|-------|---------|---------------:|---------:|---------:|
| **Analytics Suite** | Advanced Reporting (DORA) + Team Usage Analytics | $60 / mo · $600 / yr | **$40 / mo · $400 / yr** | **$20 / mo · $200 / yr** |
| **Team Growth Bundle** | ≥ 1 Seat Pack + Team Usage Analytics | $55 / mo · $550 / yr | **$35 / mo · $350 / yr** | **$20 / mo · $200 / yr** |

How it works:

- The combo applies automatically the moment its members are present — there is nothing extra to buy or redeem.
- **Minimum-quantity members.** A member can require a minimum quantity: Team Growth needs **≥ 1 Seat Pack** (= 5 seats at the default grant). It counts the purchased Seat Pack **add-on**, not the account's total tier seats, and the credit is **flat** — extra Seat Packs beyond the minimum don't increase it.
- The saving is shown up front: the add-on **preview** and the add/remove responses include a negative combo line (e.g. `Team Growth Bundle discount −$20.00`), so `totalCents` already reflects the net.
- It is **realized** as a recurring usage credit re-granted each billing period, derived fresh from the current add-on composition — the invoice reconciler grants `Σ member price × minQty − combined price` (clamped ≥ 0) per period, idempotent per invoice. Existing qualifying accounts begin receiving the credit at their **next invoice** (retroactive by design).
- **Overlap.** Team Usage Analytics belongs to both combos. You always receive the combination of combos giving the **largest total discount**, and no add-on is ever discounted twice — if two combos share a member, only the single best one applies (ties broken deterministically). So an account with DORA + Team Usage Analytics + a Seat Pack gets **one** $20 credit, not two.
- Removing a member simply stops the next re-grant (the current period's credit is not clawed back) and emits a `combo_expired` billing event; the **preview** warns "Ends your Team Growth Bundle discount — −$20/mo" before you commit.
- The billing dashboard nudges toward the pairing: when the other member is owned, an unsatisfied member's card shows a **"Completes the Team Growth Bundle — save $20/mo"** hint (the single best combo that card completes).

Combos are only advertised when **every** member is purchasable on the account's tier — Developer, for example, can't buy Team Usage Analytics, so it isn't offered either combo.

---

## Pooling across teams

For an account with [teams](organization-benefits.md#teams) (the org → team hierarchy), bundle grants raise the **root** account's pooled caps, and the whole subtree draws from that shared pool:

- **Seats** are counted as distinct active members plus pending invites across the root and all its teams, checked against the pooled seat cap at invite time.
- **Count quotas** (plugins, pipelines, …) sum each team's usage against the root's pooled cap.
- **Storage** is measured live across the subtree at image-push time (it is not pre-summed).
- Removing a bundle can't drop a pooled cap below current usage — billing's over-cap guard blocks a removal that would strand seats, plugins, or pipelines.

---

## Buying and managing bundles

Bundles are managed through the billing service (dashboard **Billing** page or the API). Mutations require an org **admin/owner**.

| Action | Endpoint |
|--------|----------|
| List available bundles | `GET /bundles` |
| Preview the effect of an add-on change | `POST /subscriptions/:id/addons/preview` |
| Add / change an add-on | `POST /subscriptions/:id/addons` |
| Remove an add-on | `DELETE /subscriptions/:id/addons/:bundleId` |
| Open the billing portal | `POST /portal` |

The **preview** endpoint returns the new effective limits before you commit, so you can confirm exactly which caps change.

---

## Configuration & overrides

Bundles are only offered when the operator enables them, and each bundle's economics are env-tunable:

| Variable | Effect |
|----------|--------|
| `BILLING_BUNDLES_ENABLED=true` | Master switch — bundles are hidden unless set |
| `BILLING_BUNDLE_<ID>_MONTHLY` / `_ANNUAL` | Override a bundle's price (cents) |
| `BILLING_BUNDLE_<ID>_GRANT` | Override the grant amount (single-dimension bundles only) |
| `BILLING_BUNDLE_<ID>_TIERS` | JSON array of tiers allowed to buy the bundle |
| `BILLING_COMBO_<COMBO>_MONTHLY` / `_ANNUAL` | Override a combo's combined price (cents) — e.g. `BILLING_COMBO_ANALYTICS_SUITE_MONTHLY` |

`<ID>` is the bundle id upper-cased: `SEAT_PACK`, `PIPELINE_PACK`, `PLUGIN_PACK`, `API_PACK`, `AI_PACK`, `STORAGE_PACK`, `RETENTION_PACK`, `DORA_HISTORY_PACK`, `AUDIT_LOG`, `SSO`, `ADVANCED_REPORTING`, `TEAM_USAGE_ANALYTICS`. `<COMBO>` is the combo id upper-cased: `ANALYTICS_SUITE`, `TEAM_GROWTH`. Under AWS Marketplace the retention packs meter as the `RetentionPack` / `DoraHistoryPack` dimensions.

> **AWS Marketplace:** when the billing provider is `aws-marketplace`, self-service bundle purchase is disabled — entitlements flow from Marketplace instead, and add-on charges are reported as **metered usage** (`BatchMeterUsage`). Combo credits (and other usage-credit discounts) realize on Marketplace by **withholding metered usage** when `BILLING_METERING_ENABLED` is on — see [Billing Discounts → AWS Marketplace](billing-discounts.md#aws-marketplace--private-offers-handled-in-aws-not-in-app). See [Environment Variables](environment-variables.md#billing) for the full billing configuration.

---

## Related

- [Feature Tiers](README.md#feature-tiers) — the tier baselines bundles build on
- [Organization Benefits → Organizations, Teams & Billing](organization-benefits.md#organizations-teams--billing) — the account/team model and how caps pool
- [Environment Variables](environment-variables.md) — billing + quota configuration reference
