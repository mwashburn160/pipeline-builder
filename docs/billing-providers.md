---
layout: default
title: Billing Providers
---

# Billing Providers — Stripe & AWS Marketplace

## Overview

Pipeline Builder charges through a pluggable **billing provider**, selected by `BILLING_PROVIDER`:

| `BILLING_PROVIDER` | Use it for | Charging model |
|---|---|---|
| `stub` (default) | Local dev / demos | No real charges — subscriptions are created in-app with no external provider |
| `stripe` | Direct SaaS billing you own | Stripe Customers + Subscriptions; the app owns plans/prices and reconciles via webhooks |
| `aws-marketplace` | Selling through AWS Marketplace | Entitlements flow **from AWS**; add-ons report as **metered usage** (`BatchMeterUsage`) |

Billing must be on (`BILLING_ENABLED=true`, the default) for any provider to serve plans. This page is the **setup walkthrough** for the two real providers. For what billing *does* once configured, see [Billing Add-on Bundles](billing-bundles.md), [Billing Discounts](billing-discounts.md), and the [Environment Variables → Billing](environment-variables.md#billing) reference.

> **One provider per deployment.** `BILLING_PROVIDER` is global. You do not run Stripe and Marketplace side by side — pick the one that matches how the deployment is sold.

---

## Stripe

Stripe billing is direct: the app creates a Stripe **Customer** per organization and a **Subscription** per plan, using **Price** objects you create in Stripe. The app owns the reduction logic (discounts are customer-balance credits, never Stripe coupons — see [Billing Discounts](billing-discounts.md)); Stripe owns the card, the invoice, and the payment. All state changes flow back through a **signed webhook**.

### What you need

- A Stripe account (start in **test mode**).
- Your plan catalog decided (`developer` / `pro` / `team` / `enterprise`) — the app's plan ids, from [Environment Variables → Billing](environment-variables.md#billing).

### Step 1 — Select the provider

```bash
BILLING_ENABLED=true
BILLING_PROVIDER=stripe
```

### Step 2 — Add your Stripe secret key

Stripe Dashboard → **Developers → API keys** → copy the **Secret key** (`sk_test_…` in test mode, `sk_live_…` in production):

```bash
STRIPE_SECRET_KEY=sk_test_xxxxxxxxxxxxxxxxxxxxxxxx
```

`STRIPE_SECRET_KEY` is a **secret** — provision it via a sealed secret / SSM, never commit it.

### Step 3 — Create Products & Prices in Stripe, then map them

In Stripe, create a **Product** + a **recurring Price** for every paid plan **and** every add-on you sell, one Price per interval (monthly and/or annual). The amount you set in Stripe **must match** the app's configured price (Stripe is what actually charges the card). Copy each Price id (`price_…`).

Then wire them all up with **`STRIPE_PRICE_MAP`** — a single JSON object whose **keys are `<id>_<interval>`** (`<id>` is a plan id *or* a bundle id) and whose **values are Stripe Price ids**. `interval` is `monthly` or `annual`.

#### Plan prices (from the four tiers)

| Plan id | Monthly | Annual | Map keys |
|---|---|---|---|
| `developer` | Free | Free | — (nothing charged) |
| `pro` | $39 | $390 | `pro_monthly`, `pro_annual` |
| `team` | $79 | $790 | `team_monthly`, `team_annual` |
| `enterprise` | $599 | $5,990 | `enterprise_monthly`, `enterprise_annual` |

The free `developer` tier needs **no** Price; the hidden `unlimited` tier is never sold. If a customer picks a plan/interval whose key is **missing**, subscription creation fails fast with `No Stripe Price ID configured for plan "…" with interval "…"` — so map every paid combination.

> **Provisioning helper.** Stripe Prices are immutable, so a fresh install (or any price change) needs new Price objects. Run `STRIPE_SECRET_KEY=… node api/billing/scripts/provision-stripe-prices.mjs` (from `api/billing`; add `--dry-run` to preview) — it reads the effective billing config, creates a Price per interval for every paid plan **and** every chargeable bundle (below), and prints the ready-to-paste `STRIPE_PRICE_MAP` JSON. Combos are customer-balance credits, not line items, so they need no Price.

#### Add-on prices (from the existing bundles)

Add-ons are charged as extra **subscription line items** on the same subscription, so each sellable bundle also needs a Stripe Price per interval, keyed `<bundleId>_<interval>` in the **same** `STRIPE_PRICE_MAP`. Annual defaults to ~10× monthly:

| Bundle id | Monthly | Annual | Map keys |
|---|---|---|---|
| `seat` | $19.99 | $199.90 | `seat_monthly`, `seat_annual` |
| `pipeline_pack` | $15 | $150 | `pipeline_pack_monthly`, `pipeline_pack_annual` |
| `plugin_pack` | $10 | $100 | `plugin_pack_monthly`, `plugin_pack_annual` |
| `api_pack` | $19.99 | $199.90 | `api_pack_monthly`, `api_pack_annual` |
| `ai_pack` | $19.99 | $199.90 | `ai_pack_monthly`, `ai_pack_annual` |
| `storage_pack` | $19.99 | $199.90 | `storage_pack_monthly`, `storage_pack_annual` |
| `retention_pack` | $15 | $150 | `retention_pack_monthly`, `retention_pack_annual` |
| `dora_history_pack` | $30 | $300 | `dora_history_pack_monthly`, `dora_history_pack_annual` |
| `audit_log` | $20 | $200 | `audit_log_monthly`, `audit_log_annual` |
| `sso` | $40 | $400 | `sso_monthly`, `sso_annual` |
| `advanced_reporting` | $30 | $300 | `advanced_reporting_monthly`, `advanced_reporting_annual` |
| `team_usage_analytics` | $30 | $300 | `team_usage_analytics_monthly`, `team_usage_analytics_annual` |
| `compliance_standard` | $29.90 | $299 | `compliance_standard_monthly`, `compliance_standard_annual` |
| `compliance_advanced` | $99.90 | $999 | `compliance_advanced_monthly`, `compliance_advanced_annual` |

> If a purchased bundle's `<bundleId>_<interval>` key is **absent** from the map, its line item is **silently skipped** — the customer gets the entitlement but is **never charged** for it. Map every bundle you enable (see `BILLING_BUNDLES_ENABLED`), only for the intervals you sell.

#### Example (plans + a few add-ons)

```bash
STRIPE_PRICE_MAP='{
  "pro_monthly":"price_1AbcPro","pro_annual":"price_1AbcProYr",
  "team_monthly":"price_1DefTeam","team_annual":"price_1DefTeamYr",
  "enterprise_monthly":"price_1GhiEnt","enterprise_annual":"price_1GhiEntYr",
  "seat_monthly":"price_1JklSeat","seat_annual":"price_1JklSeatYr",
  "sso_monthly":"price_1MnoSso","sso_annual":"price_1MnoSsoYr"
}'
```

(Provide it as a single line — expanded here only for readability. Extend it with the remaining bundle keys from the table for every add-on you sell.)

### Step 4 — Register the webhook

The app reconciles all subscription and payment state from Stripe webhooks. The endpoint is:

```
POST https://<your-public-host>/billing/stripe/webhook
```

Stripe Dashboard → **Developers → Webhooks → Add endpoint** → enter that URL, then select the events the app consumes:

| Event | Effect in Pipeline Builder |
|---|---|
| `customer.subscription.created` | Records the subscription + grants the tier |
| `customer.subscription.updated` | Re-syncs status/plan (status mapped internally; `unpaid` ⇒ canceled after grace) |
| `customer.subscription.deleted` | Cancels the subscription, downgrades tier |
| `invoice.payment_succeeded` | Marks paid / clears past-due |
| `invoice.payment_failed` | Moves to past-due (grace period applies) |
| `invoice.upcoming` | Drives renewal reminders + recurring-credit re-grant |
| `charge.refunded` | Reverses the matching subscription |
| `charge.dispute.created` | Reverses on dispute |
| `invoice.voided` / `invoice.marked_uncollectible` | Reversal handling |

Copy the endpoint's **Signing secret** (`whsec_…`) into:

```bash
STRIPE_WEBHOOK_SECRET=whsec_xxxxxxxxxxxxxxxxxxxxxxxx
```

The webhook route verifies every delivery against this secret over the **raw** request body and de-dupes redeliveries — so the URL must be publicly reachable through the nginx gateway, and `STRIPE_WEBHOOK_SECRET` must match the endpoint exactly or deliveries are rejected.

### Step 5 — Test locally with the Stripe CLI

```bash
stripe login
# Forward live test events to your local gateway and print a whsec_ to use as STRIPE_WEBHOOK_SECRET:
stripe listen --forward-to https://localhost:8443/billing/stripe/webhook
# In another shell, simulate the lifecycle:
stripe trigger customer.subscription.created
stripe trigger invoice.payment_succeeded
```

Confirm the subscription appears (`GET /billing/subscription` for the org) and the tier is granted.

### Step 6 — Go live

Swap **test → live** everywhere: `STRIPE_SECRET_KEY=sk_live_…`, a **live-mode** webhook endpoint with its own `STRIPE_WEBHOOK_SECRET`, and **live** Price ids in `STRIPE_PRICE_MAP`. Test-mode and live-mode objects never interoperate.

### How the platform implements this

Unlike AWS Marketplace (where the customer subscribes on AWS and the platform reconciles), **Stripe is driven entirely in-app and is wired end to end** — there is no external redirect and no missing UI piece:

- **Provider selection** — `getPaymentProvider()` constructs the `StripeProvider` when `BILLING_PROVIDER=stripe` and **throws at startup if `STRIPE_SECRET_KEY` is unset** (`STRIPE_SECRET_KEY is required when BILLING_PROVIDER=stripe`), so a misconfigured deployment fails fast rather than silently running stubbed.
- **Subscribe** — the dashboard Billing page calls `POST /billing/subscriptions` (authenticated, `billing:manage`), which runs `createCustomer` → `createSubscription` on the provider. `createSubscription` looks up the Stripe Price from `STRIPE_PRICE_MAP[<planId>_<interval>]` and fails fast if that key is missing.
- **Add-ons** — purchased bundles call the add-on routes, which invoke `syncAddons`; each bundle's Stripe Price comes from `STRIPE_PRICE_MAP[<bundleId>_<interval>]`, applied as an extra subscription line item (a missing key is skipped — granted but not charged).
- **Reconciliation** — all state changes come back through `POST /billing/stripe/webhook`, which verifies each delivery with `stripe.webhooks.constructEvent(rawBody, signature, STRIPE_WEBHOOK_SECRET)`, returns **503** if the secret is unset (so Stripe retries rather than the app processing unsigned payloads), and de-dupes redeliveries by `event.id`. The consumed event set is the table in Step 4.

Net: enabling Stripe is **purely configuration** (`BILLING_PROVIDER`, the two secrets, and `STRIPE_PRICE_MAP`) — the subscribe UI, add-on flow, and webhook reconciliation already ship.

### Stripe environment variables

| Variable | Default | Description |
|---|---|---|
| `STRIPE_SECRET_KEY` | — | **Secret.** Stripe API secret key (`sk_test_…` / `sk_live_…`). Required when `BILLING_PROVIDER=stripe` |
| `STRIPE_WEBHOOK_SECRET` | — | **Secret.** Signing secret (`whsec_…`) for the endpoint at `POST /billing/stripe/webhook`; every delivery is signature-verified against it |
| `STRIPE_PRICE_MAP` | `{}` | JSON map of `<id>_<interval>` → Stripe Price id, where `<id>` is a **plan id or a bundle id** (e.g. `{"pro_monthly":"price_…","seat_annual":"price_…"}`). A plan/interval absent here cannot be subscribed; a bundle absent here is granted but not charged |

Stripe subscription statuses are mapped to internal statuses by a fixed table in the app (no env var); notably `unpaid` ⇒ `canceled` (Stripe sets `unpaid` only after the grace period), and unknown statuses fall back to `incomplete`.

---

## AWS Marketplace

Under AWS Marketplace the **customer subscribes on AWS**, not in-app. AWS owns the contract and the bill; Pipeline Builder **resolves** the customer on redirect, reads **entitlements** to set the tier, listens to **SNS** for lifecycle changes, and reports add-on consumption as **metered usage**. Self-service in-app bundle purchase is disabled — entitlements flow from AWS.

### What you need

- An AWS Marketplace **seller** account and a **SaaS** product listing.
- The billing service running with an AWS identity (task role) that can call the Marketplace APIs (Step 5).

### Step 1 — Create the SaaS listing & dimensions

In the AWS Marketplace Management Portal, create the **SaaS product** and define its **dimensions**:

- **Tier dimensions** — one per sellable plan (map to `pro` / `team` / `enterprise`).
- **Metered add-on dimensions** — one per add-on you meter (seat pack, pipeline pack, retention pack, etc.).

Note the **product code** AWS assigns.

### Step 2 — Select the provider & product

```bash
BILLING_ENABLED=true
BILLING_PROVIDER=aws-marketplace
AWS_MARKETPLACE_PRODUCT_CODE=<your-product-code>
AWS_MARKETPLACE_REGION=us-east-1        # defaults to AWS_REGION, else us-east-1
```

### Step 3 — Point the Fulfillment (registration) URL at the app

Set the product's **Fulfillment URL** to the built-in fulfillment page:

```
https://<your-public-host>/marketplace/register
```

AWS **POSTs** the `x-amzn-marketplace-token` here as a form field after a customer subscribes. Because the AWS purchaser is not yet a Pipeline Builder user at this point, registration is **two-phase**:

1. **Resolve** (public, the AWS redirect target) — `POST /billing/marketplace/resolve` runs **`ResolveCustomer`** on the token → **`GetEntitlements`** to determine the entitled tier (a dimension with no map entry falls back to `developer`) → banks a **short-lived, single-use `registrationRef`** (30 min TTL). It does **not** create a subscription yet — there's no org to bind to. If the customer is already linked, it returns `alreadyRegistered` instead.
   ```
   POST /billing/marketplace/resolve   Body: { "token": "<x-amzn-marketplace-token>" }
   → { registrationRef, planName }  |  { alreadyRegistered: true }
   ```
2. **Claim** (authenticated) — once the purchaser signs up / signs in, `POST /billing/marketplace/claim` (`billing:manage`) binds the `registrationRef` to **their organization**, creating the subscription (keyed on the real orgId; the AWS `customerIdentifier` is stored only in metadata, never the AWS account id) and syncing the tier to quota.
   ```
   POST /billing/marketplace/claim   Body: { "registrationRef": "<ref>" }
   ```

The `/marketplace/register` page handles both: it resolves the token, then either shows a **"Link to my organization"** button (if already signed in) or sends the purchaser through sign-up/sign-in — carrying the `registrationRef` so it's **claimed automatically** when they reach the dashboard. Guards: a `registrationRef` binds **once** (single-use), an AWS customer can't bind to two orgs (**409**), and an org that already has an active subscription is rejected (**409**).

### Step 4 — Subscribe the SNS notification endpoint

AWS Marketplace publishes entitlement/subscription notifications to an **SNS topic you own**. Set its ARN and subscribe the app's SNS webhook (HTTPS) to the topic:

```bash
AWS_MARKETPLACE_SNS_TOPIC_ARN=arn:aws:sns:us-east-1:<acct>:aws-mp-subscription-notification-<code>
```

```
POST https://<your-public-host>/billing/marketplace/sns
```

The endpoint confirms the SNS `SubscriptionConfirmation` handshake and **verifies message signatures**, then processes entitlement updates, cancellations, and reactivations (re-checking entitlements and updating the plan).

### Step 5 — Grant IAM permissions

The billing service's task role needs the Marketplace APIs it calls:

```json
{
  "Effect": "Allow",
  "Action": [
    "aws-marketplace:ResolveCustomer",
    "aws-marketplace:GetEntitlements",
    "aws-marketplace:BatchMeterUsage"
  ],
  "Resource": "*"
}
```

Plus permission to receive from / confirm the SNS subscription for your topic.

### Step 6 — Map dimensions

Three JSON maps connect AWS dimensions to the app's plans, add-ons, and prices:

| Variable | Default | Maps | Purpose |
|---|---|---|---|
| `AWS_MARKETPLACE_DIMENSION_MAP` | identity | Marketplace **tier dimension → local plan id** | Resolve the entitled tier from `GetEntitlements` |
| `AWS_MARKETPLACE_BUNDLE_DIMENSION_MAP` | identity | Add-on **bundle id → metered dimension key** | Which dimension each add-on reports under |
| `AWS_MARKETPLACE_DIMENSION_PRICE_MAP` | `{}` | Metered **dimension → cents per unit per cycle** | Drives credit drawdown; an unpriced dimension is reported in full |

#### Tier dimensions (from the four plans)

Create one AWS entitlement dimension per **paid** tier. The free `developer` tier needs no dimension — an entitlement that resolves to nothing falls back to `developer`. If you name the AWS dimensions to match the plan ids, the identity default applies and you can omit `AWS_MARKETPLACE_DIMENSION_MAP` entirely; the explicit map is shown for clarity:

| Plan id | Monthly (default) | Suggested AWS dimension | Needs a dimension? |
|---|---|---|---|
| `developer` | Free | — | No — the fallback tier |
| `pro` | $39 | `pro` | Yes |
| `team` | $79 | `team` | Yes |
| `enterprise` | $599 | `enterprise` | Yes |

```bash
# Identity naming → this line is optional (it's the default):
AWS_MARKETPLACE_DIMENSION_MAP='{"pro":"pro","team":"team","enterprise":"enterprise"}'
```

#### Add-on dimensions (from the existing bundles)

Create one **metered** AWS dimension per add-on you sell. Map each bundle id → its AWS dimension name, and give each dimension its per-unit list price (cents) so credit drawdown values a withheld unit correctly. The rows below use every add-on that ships today, at its default monthly price:

| Bundle id | AWS dimension | List price (default) | Available tiers |
|---|---|---|---|
| `seat` | `Seat` | $19.99 (`1999`) | team, enterprise |
| `pipeline_pack` | `PipelinePack` | $15 (`1500`) | team, enterprise |
| `plugin_pack` | `PluginPack` | $10 (`1000`) | all |
| `api_pack` | `ApiPack` | $19.99 (`1999`) | all |
| `ai_pack` | `AiPack` | $19.99 (`1999`) | all |
| `storage_pack` | `StoragePack` | $19.99 (`1999`) | all |
| `retention_pack` | `RetentionPack` | $15 (`1500`) | all (max 7) |
| `dora_history_pack` | `DoraHistoryPack` | $30 (`3000`) | all (max 1) |
| `audit_log` | `AuditLog` | $20 (`2000`) | pro |
| `sso` | `Sso` | $40 (`4000`) | pro |
| `advanced_reporting` | `AdvancedReporting` | $30 (`3000`) | developer, pro, team |
| `team_usage_analytics` | `TeamUsageAnalytics` | $30 (`3000`) | pro, team |
| `compliance_standard` | `ComplianceStandard` | $29.90 (`2990`) | developer, pro, team |
| `compliance_advanced` | `ComplianceAdvanced` | $99.90 (`9990`) | developer, pro, team |

```bash
AWS_MARKETPLACE_BUNDLE_DIMENSION_MAP='{"seat":"Seat","pipeline_pack":"PipelinePack","plugin_pack":"PluginPack","api_pack":"ApiPack","ai_pack":"AiPack","storage_pack":"StoragePack","retention_pack":"RetentionPack","dora_history_pack":"DoraHistoryPack","audit_log":"AuditLog","sso":"Sso","advanced_reporting":"AdvancedReporting","team_usage_analytics":"TeamUsageAnalytics","compliance_standard":"ComplianceStandard","compliance_advanced":"ComplianceAdvanced"}'

AWS_MARKETPLACE_DIMENSION_PRICE_MAP='{"Seat":1999,"PipelinePack":1500,"PluginPack":1000,"ApiPack":1999,"AiPack":1999,"StoragePack":1999,"RetentionPack":1500,"DoraHistoryPack":3000,"AuditLog":2000,"Sso":4000,"AdvancedReporting":3000,"TeamUsageAnalytics":3000,"ComplianceStandard":2990,"ComplianceAdvanced":9990}'
```

Only list the add-ons you actually sell on Marketplace — a bundle with no dimension mapping isn't metered, and a dimension with no price in `AWS_MARKETPLACE_DIMENSION_PRICE_MAP` is reported in full (never drawn against for credit). Tier availability (the "Available tiers" column) is enforced separately by `BILLING_BUNDLE_<ID>_TIERS`.

> **The price-map values are cents per metered unit per metering cycle** (cycle = `BILLING_METERING_INTERVAL_MS`). The prices above are the **monthly** list defaults; if your metering cadence isn't monthly, scale each value to the cycle. Either way, **mirror your AWS listing's dimension prices exactly** — a wrong value directly mis-draws credit.

### Step 7 — Enable metering (validate in dry-run first)

Add-on charges and usage-credit realization run on the metering cycle. Turn it on, but **shadow it first**:

```bash
BILLING_METERING_ENABLED=true
BILLING_METERING_INTERVAL_MS=3600000        # 1h; AWS BatchMeterUsage dedupes by (customer, dimension, hour)
BILLING_METERING_DRAWDOWN_DRYRUN=true        # compute + log intended withholding, report FULL quantities, touch nothing
```

Watch the logs for a cycle or two, confirm the intended dimensions/quantities match your listing, then set `BILLING_METERING_DRAWDOWN_DRYRUN=false` to go live.

> Metering is **default-off**, and usage-credit discounts on Marketplace require **both** `BILLING_DISCOUNTS_ENABLED` and `BILLING_METERING_ENABLED` — a credit would otherwise bank but never reduce the AWS bill, so it's rejected. See [Billing Discounts → AWS Marketplace](billing-discounts.md#aws-marketplace--private-offers-handled-in-aws-not-in-app).

### Step 8 — Verify

- Subscribe a test customer on the listing → land on the fulfillment URL → confirm the subscription is created (`GET /billing/marketplace/entitlements`).
- Trigger an entitlement change and confirm the SNS endpoint updates the plan.
- With dry-run on, confirm the metering cycle logs the expected `BatchMeterUsage` dimensions before going live.

### AWS Marketplace environment variables

| Variable | Default | Description |
|---|---|---|
| `AWS_MARKETPLACE_PRODUCT_CODE` | — | The Marketplace product code |
| `AWS_MARKETPLACE_REGION` | `AWS_REGION` or `us-east-1` | Region for the Metering/Entitlement clients |
| `AWS_MARKETPLACE_SNS_TOPIC_ARN` | — | SNS topic for entitlement/subscription notifications |
| `AWS_MARKETPLACE_DIMENSION_MAP` | identity | JSON map of Marketplace tier dimension → local plan id |
| `AWS_MARKETPLACE_BUNDLE_DIMENSION_MAP` | identity | JSON map of add-on bundle id → metered dimension key |
| `AWS_MARKETPLACE_DIMENSION_PRICE_MAP` | `{}` | JSON map of metered dimension → local list price in cents per metered unit per cycle |
| `BILLING_METERING_ENABLED` | `false` | Run the metering cycle (report add-on usage + realize credits). Off = no metering, and Marketplace credits are rejected |
| `BILLING_METERING_INTERVAL_MS` | `3600000` | Metering cycle cadence (1 hour) |
| `BILLING_METERING_DRAWDOWN_DRYRUN` | `false` | Shadow mode — compute + log intended withholding but report full quantities and leave balances untouched |

---

## Endpoints reference

| Endpoint | Auth | Provider | Purpose |
|---|---|---|---|
| `POST /billing/stripe/webhook` | Signature | Stripe | Receives + verifies Stripe events (raw body) |
| `POST /billing/marketplace/resolve` | None (AWS redirect) | Marketplace | Exchange a registration token for a single-use `registrationRef` (banks a pending registration; no subscription yet) |
| `POST /billing/marketplace/claim` | Auth (`billing:manage`) | Marketplace | Bind a `registrationRef` to the caller's org and create the subscription |
| `POST /billing/marketplace/sns` | SNS signature | Marketplace | Entitlement/subscription lifecycle notifications |
| `GET /billing/marketplace/entitlements` | Auth | Marketplace | Current entitlements for the account |

The frontend fulfillment page lives at `/marketplace/register` (set this as the AWS Fulfillment URL).

## Related

- [Environment Variables → Billing](environment-variables.md#billing) — every billing variable, including plan pricing
- [Billing Add-on Bundles](billing-bundles.md) — stackable add-ons (metered on Marketplace)
- [Billing Discounts](billing-discounts.md) — usage credits; Stripe in-app vs. Marketplace withholding
