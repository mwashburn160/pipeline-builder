---
layout: default
title: Billing Add-on Bundles
---

<!--
Copyright 2026 Pipeline Builder Contributors
SPDX-License-Identifier: Apache-2.0
-->

# Billing Add-on Bundles

Purchasable packs that stack **on top of** an account's subscription tier to raise its caps or unlock features — without moving the whole account to a higher tier.

## Highlights

- **One governing rule:** `effective[quota] = tierBase[quota] + Σ(bundle.grant × quantity)`.
- **A team that needs a few more seats buys the pack**, rather than jumping from Pro to Enterprise.
- **Caps pool at the account root.** The whole org → team subtree draws from one shared pool.
- **Combos apply automatically** the moment their members are present — nothing to buy or redeem — and you always get the combination giving the **largest total discount**, never a double discount.
- **Discounts are recurring usage credits, never provider coupons**, so the `preview` shows a negative line and `totalCents` is already net.
- **An unlimited baseline stays unlimited.** Bundles never shrink a `-1`.
- **Two things are deliberately not sold:** SSO (a Team-and-up tier feature) and Verified publishing (eligibility only, awarded after review).
- **Removal can't strand usage.** An over-cap guard blocks a removal that would drop a pooled cap below current usage.

## Overview

The tier sets the baseline; bundles adjust it. This page is the operator and admin reference for what each bundle grants, how the combo discounts work, how caps pool across teams, and the endpoints and environment overrides for managing them.

Written for org **admins and owners** buying extra capacity, and for operators configuring the catalog. For the tier baselines bundles build on, see [feature tiers](README.md#feature-tiers); for the org/team model the caps apply to, see [Organization Benefits](organization-benefits.md#organizations-teams--billing).

## How it works

1. **Enable** — an operator sets `BILLING_BUNDLES_ENABLED=true`. Self-service purchase is disabled under AWS Marketplace.
2. **Preview** — an admin lists bundles (`GET /bundles`) and previews a change (`POST /subscriptions/:id/addons/preview`) to confirm the new effective limits before committing.
3. **Purchase** — add or change an add-on (`POST /subscriptions/:id/addons`). Stackable packs can be bought in quantity.
4. **Compute** — billing recomputes `effective[quota] = tierBase + Σ(grant × quantity)` and applies any qualifying **combo** as a recurring usage credit, using best-combo packing so nothing is discounted twice.
5. **Sync and pool** — the effective entitlement is pushed to the enforcing services and pooled at the **account root** across every team.

### Where the effective entitlement is synced

| What | Goes to | Via |
|---|---|---|
| The nine tracked quota types | quota service | quota sync |
| `seats` and purchased features (e.g. `advanced_reporting`) | platform service | `PUT /organization/{orgId}/seat-limit` |
| Effective **retention** windows | reporting service | `PUT /api/reports/retention-sync/{orgId}`, writing `dora_settings` |

All three target the account root. Retention is not one of the nine flow quotas — it reuses the tier-baseline + bundle-grant math but rides its own reporting sync leg.

### What stacking does and does not do

- **Stackable bundles** can be purchased in quantity — enter 15 Member Seats for +15 seats, with a volume discount.
- An **unlimited** baseline (`-1`, e.g. Team/Enterprise `apiCalls`) stays unlimited. Bundles never shrink it.
- **Feature bundles** (Advanced Reporting, Team Usage Analytics, Standard/Advanced Compliance, Stakeholder Reports) add a capability rather than a number, and are not stackable.
- Effective limits are **pooled at the account root** — see [pooling](#pooling-across-teams).

## Configuration

1. **Turn bundles on.** `BILLING_BUNDLES_ENABLED=true`. Bundles are hidden unless set.
2. **Override any economics you need to** with the variables below. Every price, grant and eligible-tier list is env-tunable.
3. **Confirm the provider.** Under AWS Marketplace, self-service purchase is off and add-on charges are reported as metered usage instead.
4. **Have admins preview before committing.** `POST /subscriptions/:id/addons/preview` returns the new effective limits, so the caps that change are visible in advance.

### Overrides

| Variable | Effect |
|----------|--------|
| `BILLING_BUNDLES_ENABLED=true` | Master switch — bundles are hidden unless set |
| `BILLING_BUNDLE_<ID>_MONTHLY` / `_ANNUAL` | Override a bundle's price (cents) |
| `BILLING_BUNDLE_<ID>_GRANT` | Override the grant amount (single-dimension bundles only) |
| `BILLING_BUNDLE_<ID>_TIERS` | JSON array of tiers allowed to buy the bundle |
| `BILLING_BUNDLE_SEAT_VOLUME_TIERS` | Tune the Member Seat volume-discount thresholds |
| `BILLING_COMBO_<COMBO>_MONTHLY` / `_ANNUAL` | Override a combo's combined price (cents) — e.g. `BILLING_COMBO_ANALYTICS_SUITE_MONTHLY` |

`<ID>` is the bundle id upper-cased: `SEAT`, `PIPELINE_PACK`, `PLUGIN_PACK`, `API_PACK`, `AI_PACK`, `STORAGE_PACK`, `LISTING_PACK`, `RETENTION_PACK`, `DORA_HISTORY_PACK`, `ADVANCED_REPORTING`, `TEAM_USAGE_ANALYTICS`, `COMPLIANCE_STANDARD`, `COMPLIANCE_ADVANCED`, `STAKEHOLDER_REPORTS`.

`<COMBO>` is the combo id upper-cased: `ANALYTICS_SUITE`, `TEAM_GROWTH`, `COMPLIANCE_SUITE`, `SCALE_BUNDLE`.

> **AWS Marketplace:** when the billing provider is `aws-marketplace`, self-service bundle purchase is disabled — entitlements flow from Marketplace instead, and add-on charges are reported as **metered usage** (`BatchMeterUsage`). The retention packs meter as the `RetentionPack` / `DoraHistoryPack` dimensions. Combo credits (and other usage-credit discounts) realize on Marketplace by **withholding metered usage** when `BILLING_METERING_ENABLED` is on — see [Billing Discounts → AWS Marketplace](billing-discounts.md#aws-marketplace--private-offers-handled-in-aws-not-in-app). See [Environment Variables](environment-variables.md#billing) for the full billing configuration.

## The bundles

Prices are the built-in defaults (USD); annual defaults to 10× monthly.

| Bundle | Grant | Monthly | Annual | Available to | Stackable |
|--------|-------|--------:|-------:|--------------|:---------:|
| **Member Seat** | +1 member seat (volume discounts — see below) | $19.99 | $199.90 | Team, Enterprise | ✅ |
| **Pipeline Pack** | +5 pipelines | $15 | $150 | Team, Enterprise | ✅ |
| **Plugin Pack** | +25 plugins | $10 | $100 | all tiers | ✅ |
| **API Pack** | +100,000 API calls / period | $19.99 | $199.90 | all tiers | ✅ |
| **AI Pack** | +2,500 AI calls / period | $19.99 | $199.90 | all tiers | ✅ |
| **Storage Pack** | +10 GB registry storage | $19.99 | $199.90 | all tiers | ✅ |
| **Listing Pack** | +10 public plugin-ecosystem listings (the `listings` count quota) | $4.99 | $49.90 | all tiers | ✅ |
| **Standard Retention Pack** | +90 days standard pipeline-event retention | $15 | $150 | all tiers | ✅ (max 7) |
| **DORA History Pack** | +365 days DORA history **and** +365 days on the per-org report-query window | $30 | $300 | all tiers | ✅ (max 1) |
| **Advanced Reporting (DORA)** | unlocks the `advanced_reporting` feature | $30 | $300 | Developer, Pro, Team | ❌ |
| **Team Usage Analytics** | unlocks the `team_usage_analytics` feature (per-team usage breakdown across the org → team subtree) | $30 | $300 | Pro, Team | ❌ |
| **Standard Compliance** | unlocks the `compliance_standard` feature — a curated **CI/CD best-practice** rule library (~20 rules) | $29.90 | $299 | Developer, Pro, Team | ❌ |
| **Advanced Compliance** | unlocks the `compliance_advanced` feature — curated **SOC2 / PCI-DSS / CIS** framework libraries — **requires Standard Compliance** | $99.90 | $999 | Developer, Pro, Team | ❌ |
| **Stakeholder Reports** | unlocks the `stakeholder_reports` feature — saved, scheduled manager-facing reports: frozen period snapshots, review-and-publish, email / in-app / Slack / Teams delivery and expiring share links | $30 | $300 | Pro, Team | ❌ |

### Why the capacity packs are tier-restricted

**Member Seat** and **Pipeline Pack** are the tier differentiators, so both are restricted to **Team / Enterprise** — a single-seat Developer or Pro can't cheaply stack them to undercut Team, and must upgrade instead. The other capacity packs (plugin, API, AI, storage, listing) stay all-tier.

**API Pack** is available on every tier, since all tiers now have a finite API-call cap (Team 500k, Enterprise 900k) that can be topped up.

### Member Seat volume discounts

Seats are per-unit ($19.99 each), and the more you buy the cheaper each gets:

| Seats | Discount off the seat line |
|---:|---|
| ≥ 5 | 10% |
| ≥ 15 | 20% |
| ≥ 40 | 30% |

The discount is realized as a recurring usage credit, like a combo, so the provider still charges unit × quantity and the credit offsets the balance. The add-on **preview** shows a negative "Member Seat volume discount" line so `totalCents` reflects the net. Thresholds are env-tunable via `BILLING_BUNDLE_SEAT_VOLUME_TIERS`.

### Listing Pack and the listings quota

**Listing Pack** raises the `listings` count quota — the number of active public listings an org's publisher can hold in the plugin ecosystem. Tier base: Developer 3, Pro 10, Team 25, Enterprise 100. Installing plugins is free on every plan and needs no pack.

Like plugins and pipelines it is a **count**, so removing packs below the org's current active-listing count is refused by the over-cap guard. A **plan** downgrade is different: it is never refused for listings — the listings stay listed, and new versions and listing updates are refused (security fixes excepted) until the org is back under its limit (notice N29). The limit is enforced when a publish request is submitted and again when it is approved; see [Plugin Publishing](plugin-publishing.md#plans-and-limits).

### Retention is tier-aware and bundle-extendable

Each tier carries a baseline reporting-retention window — paid tiers default to **30 days** for standard pipeline events and **180 days** for DORA source, while the **unlimited** tier is **unlimited retention** (`-1`, history is never swept).

The two retention packs stack like every other pack: effective retention = tier baseline + Σ(pack grant × quantity). Buy **Standard Retention Pack ×2** for +180 days of standard-event history. Billing computes that effective window and syncs it to the reporting service (`dora_settings.event_retention_days` / `dora_retention_days`).

The **DORA History Pack** also widens the per-org report-query window, which now tracks retention and is capped at an absolute 730 days — so a pack holder can actually query the extended range, not just retain the raw rows. It only does anything useful alongside **Advanced Reporting (DORA)**.

### Stakeholder Reports

- **It carries the report's DORA sections.** A buyer does not also need Advanced Reporting to see them: the live DORA dashboard stays behind `advanced_reporting`, but a *report's* DORA panels do not. An add-on whose headline numbers are locked behind a second purchase is not what its own description promises.
- **One free preview per organization, ever.** An org without the add-on can generate a single watermarked sample report from its own data. It cannot be scheduled or shared — nothing is persisted, so there is no definition to schedule and no run to link to. Not per user and not per month: the preview exists so a lead can see their own numbers before asking anyone to pay, which takes one report.
- **On lapse, every report in the ACCOUNT pauses** with the reason `entitlement`, including reports owned by teams under the root — entitlement is pooled at the root, so pausing only the root would leave the teams running on a cancelled subscription. Published snapshots stay readable and existing share links live until they expire; no new link is minted and nothing new is delivered. Re-subscribing resumes exactly what the lapse paused; a report paused because its *owner* was deactivated stays paused. Upgrading to Enterprise prunes the charge and keeps the capability.
- **Not sold to Developer.** A single developer has nobody to report upward to, so the SKU would be an upsell for something they cannot use. It is included on Enterprise and Unlimited, and the on-demand report dashboards stay free on every plan — what this sells is **saving, scheduling and publishing** a report. See [Stakeholder Reports](stakeholder-reports.md).

### Compliance content add-ons

**Standard / Advanced Compliance** unlock curated compliance-content libraries (see [Compliance → Curated content add-ons](compliance.md#curated-content-add-ons-standard--advanced)). Both are purchasable on **Developer / Pro / Team** and **included on Enterprise / Unlimited**, where there is nothing to buy.

**Advanced requires Standard.** The purchase route rejects adding Advanced alone (400), so buy Standard first and add Advanced, or buy the **Compliance Suite** combo to get both at once. Cancelling Standard while Advanced is held **cascade-cancels** Advanced.

These bundles gate only the curated libraries — **authoring your own org rules stays free and ungated** on every tier.

### Buy-up-a-capability add-ons

**Advanced Reporting** and **Team Usage Analytics** are the "buy a capability without changing tier" path. Each is standard from Enterprise up, and the bundle lets a lower tier add it à la carte — so the add-on is offered only to the tiers that don't already include it: Advanced Reporting to Developer/Pro/Team, Team Usage Analytics to Team, since Developer and Pro can't nest teams and so have nothing to break down.

### What is deliberately not sold

**SSO is not an add-on.** It is a **tier** feature from **Team** up, and there is deliberately no way to buy it below that. It used to be a $40/mo Pro-only bundle, which was both dominated and broken: Pro ($39) plus the add-on cost exactly Team ($79), which includes SSO *and* teams *and* domain registration; and SSO needs a **DNS-verified email domain**, which is itself a Team/Enterprise tier check — so a Pro buyer's Okta / Entra / generic-OIDC / SAML connection failed at callback with `OIDC_EMAIL_DOMAIN_NOT_VERIFIED`. A lower tier that needs SSO upgrades to Team; the UI's `sso` lock links to the **Plans** tab rather than to an add-on. See [Authentication → Per-org enterprise SSO](authentication.md#per-org-enterprise-sso).

**Verified publishing is not sold.** The `verified_publisher` feature (Team, Enterprise and billing-off instances) only makes an org *eligible* to apply for the Verified badge; the system org awards it after review. No bundle adds it. A Verified publisher whose plan drops below Team keeps the badge for a 30-day grace period, then returns to Community.

## Combo pricing

Some add-ons are cheaper bought together. When an account holds **every** member of a combo, each at or above its minimum quantity, the set is billed at a reduced **combined price** instead of the sum of the members — and the difference is realized as a recurring **usage credit** (never a provider coupon), consistent with the [discount model](billing-discounts.md).

| Combo | Members | Buy separately | Together | You save |
|-------|---------|---------------:|---------:|---------:|
| **Analytics Suite** | Advanced Reporting (DORA) + Team Usage Analytics + Stakeholder Reports | $90 / mo · $900 / yr | **$63 / mo · $630 / yr** | **$27 / mo · $270 / yr** |
| **Team Growth Bundle** | ≥ 5 Member Seats + Team Usage Analytics | $129.95 / mo · $1,299.50 / yr | **$90.99 / mo · $909.90 / yr** | **$38.96 / mo · $389.60 / yr** |
| **Compliance Suite** | Standard Compliance + Advanced Compliance | $129.80 / mo · $1,298 / yr | **$90.86 / mo · $908.60 / yr** | **$38.94 / mo · $389.40 / yr** |
| **Scale Bundle** | API Pack + Storage Pack | $39.98 / mo · $399.80 / yr | **$27.99 / mo · $279.90 / yr** | **$11.99 / mo · $119.90 / yr** |

How it works:

- The combo applies **automatically** the moment its members are present — there is nothing extra to buy or redeem.
- **Minimum-quantity members.** A member can require a minimum quantity: Team Growth needs **≥ 5 Member Seats**. It counts the purchased Seat **add-on**, not the account's total tier seats, and the credit is **flat** — extra seats beyond the minimum don't increase it.
- The saving is shown up front: the add-on **preview** and the add/remove responses include a negative combo line (e.g. `Team Growth Bundle discount −$38.96`), so `totalCents` already reflects the net.
- It is **realized** as a recurring usage credit re-granted each billing period, derived fresh from the current add-on composition — the invoice reconciler grants `Σ member price × minQty − combined price` (clamped ≥ 0) per period, idempotent per invoice. Existing qualifying accounts begin receiving the credit at their **next invoice**, retroactive by design.
- **Overlap.** Team Usage Analytics belongs to both the Analytics Suite and Team Growth. You always receive the combination of combos giving the **largest total discount**, and no add-on is ever discounted twice — if two combos share a member, only the single best one applies, with ties broken deterministically. So an account with DORA + Team Usage Analytics + seats gets **one** $27 credit (the larger Analytics Suite), not two.
- Removing a member simply stops the next re-grant — the current period's credit is not clawed back — and emits a `combo_expired` billing event. The **preview** warns "Ends your Team Growth Bundle discount — −$38.96/mo" before you commit.
- The billing dashboard nudges toward the pairing: when the other member is owned, an unsatisfied member's card shows a **"Completes the Team Growth Bundle — save $38.96/mo"** hint, for the single best combo that card completes.

**Proration note.** A mid-period seat increase is prorated by the provider at the full unit price; the volume-discount credit reconciles at the **next invoice**, so the discount lags one cycle on the proration amount, then catches up automatically. Steady state — full billing periods — is unaffected.

Combos are only advertised when **every** member is purchasable on the account's tier. Developer, for example, can't buy Team Usage Analytics, so it isn't offered either combo.

## Pooling across teams

For an account with [teams](organization-benefits.md#teams), bundle grants raise the **root** account's pooled caps, and the whole subtree draws from that shared pool:

- **Seats** are counted as distinct active members plus pending invites across the root and all its teams, checked against the pooled seat cap at invite time.
- **Count quotas** (plugins, pipelines, …) sum each team's usage against the root's pooled cap.
- **Storage** is measured live across the subtree at image-push time — it is not pre-summed.
- Removing a bundle can't drop a pooled cap below current usage: billing's over-cap guard blocks a removal that would strand seats, plugins or pipelines.

## Buying and managing bundles

Bundles are managed through the billing service — the dashboard **Billing** page or the API. Mutations require an org **admin/owner**.

| Action | Endpoint |
|--------|----------|
| List available bundles | `GET /bundles` |
| Preview the effect of an add-on change | `POST /subscriptions/:id/addons/preview` |
| Add / change an add-on | `POST /subscriptions/:id/addons` |
| Remove an add-on | `DELETE /subscriptions/:id/addons/:bundleId` |
| Open the billing portal | `POST /portal` |

The **preview** endpoint returns the new effective limits before you commit, so you can confirm exactly which caps change.

## Related

- [Feature Tiers](README.md#feature-tiers) — the tier baselines bundles build on
- [Billing Discounts](billing-discounts.md) — the usage-credit model combos are realized through
- [Billing Providers](billing-providers.md) — Stripe and AWS Marketplace setup
- [Organization Benefits](organization-benefits.md#organizations-teams--billing) — the account/team model and how caps pool
- [Environment Variables](environment-variables.md#billing) — billing and quota configuration reference
