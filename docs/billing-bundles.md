---
layout: default
title: Billing Add-on Bundles
---

# Billing Add-on Bundles

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

Billing computes the effective entitlement and syncs it to the enforcing services: the nine tracked quota types go to the **quota service**, while `seats` and purchased features (`audit_log`, `sso`) go to the **platform service** (`PUT /organization/{orgId}/seat-limit`). Both target the account root.

---

## The bundles

Prices are the built-in defaults (USD); annual defaults to 10× monthly. Every price, grant, and eligible-tier list is env-overridable (see [Overrides](#configuration--overrides)).

| Bundle | Grant | Monthly | Annual | Available to | Stackable |
|--------|-------|--------:|-------:|--------------|:---------:|
| **Seat Pack** | +5 member seats | $25 | $250 | all tiers | ✅ |
| **Pipeline Pack** | +10 pipelines | $15 | $150 | all tiers | ✅ |
| **Plugin Pack** | +100 plugins | $10 | $100 | all tiers | ✅ |
| **API Pack** | +1,000,000 API calls / period | $20 | $200 | Developer, Pro | ✅ |
| **AI Pack** | +5,000 AI calls / period | $30 | $300 | all tiers | ✅ |
| **Storage Pack** | +50 GB registry storage | $10 | $100 | all tiers | ✅ |
| **Audit Log** | unlocks the `audit_log` feature | $20 | $200 | Pro | ❌ |
| **SSO / IdP** | unlocks `sso` + up to 5 IdP configs | $40 | $400 | Pro, Team | ❌ |

Notes:
- **API Pack** is offered only to Developer and Pro because Team and Enterprise already have unlimited API calls.
- **Audit Log** and **SSO** are the "buy up a capability without changing tier" path: Audit Log is standard from the Team tier up, and SSO from Enterprise — the bundles let a Pro (or Pro/Team) account add them à la carte.

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

`<ID>` is the bundle id upper-cased: `SEAT_PACK`, `PIPELINE_PACK`, `PLUGIN_PACK`, `API_PACK`, `AI_PACK`, `STORAGE_PACK`, `AUDIT_LOG`, `SSO`.

> **AWS Marketplace:** when the billing provider is `aws-marketplace`, self-service bundle purchase is disabled — entitlements flow from Marketplace instead. See [Environment Variables](environment-variables.md) for the full billing configuration.

---

## Related

- [Feature Tiers](README.md#feature-tiers) — the tier baselines bundles build on
- [Organization Benefits → Organizations, Teams & Billing](organization-benefits.md#organizations-teams--billing) — the account/team model and how caps pool
- [Environment Variables](environment-variables.md) — billing + quota configuration reference
