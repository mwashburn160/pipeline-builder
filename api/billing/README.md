# billing

Subscription management, plan catalog, usage rollups, and payment processing (Stripe / AWS Marketplace) for the pipeline-builder platform. The API gateway (nginx) routes `/api/billing/*` here.

## Responsibilities

- Serves the plan catalog and an org's current subscription, and drives plan changes, cancellation, and reactivation.
- Processes payments through a pluggable provider (`stub`, `stripe`, or `aws-marketplace`), verifying Stripe webhook signatures and AWS Marketplace license events (EventBridge, delivered via a signed SNS topic).
- Syncs the org's tier to the quota service on plan changes (via service-to-service auth) and exposes a combined billing + usage rollup for the dashboard.
- Runs a background lifecycle checker that downgrades orgs past their payment grace period, flags expired subscriptions, and sends renewal reminders through the message service.
- Mongo-backed; with `BILLING_ENABLED=false` the service starts but never connects to Mongo, and returns `503` for every `/billing` route except `GET /billing/config`.

## Endpoints

All paths are under `/billing`. `GET /billing/config` (enabled flag + provider name, no auth) answers in both modes; with `BILLING_ENABLED=false` every other `/billing` path returns `503`.

**Plans, subscription, usage** (org-scoped; reads need `billing:read`, writes `billing:manage` from the account root org)

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/plans`, `/plans/:planId` | Plan catalog (cached) |
| GET | `/subscriptions` | The org's manageable (active / trialing / past_due) subscription |
| POST | `/subscriptions/checkout` | Start a hosted checkout (Stripe) |
| POST | `/subscriptions` | Create a subscription directly |
| PUT | `/subscriptions/:id` | Change plan / interval |
| POST | `/subscriptions/:id/cancel` | Cancel at period end (step-up) |
| POST | `/subscriptions/:id/reactivate` | Undo a pending cancellation |
| GET | `/usage` | Combined subscription + quota usage rollup |
| GET | `/charges`, `/bundles`, `/crossover`, `/plan-preview` | Itemized standing bill, add-on catalog, crossover and plan-change previews |
| POST | `/portal` | Open a provider billing-portal session |
| POST | `/subscriptions/:id/addons/preview` | Dry-run an add-on change |
| POST | `/subscriptions/:id/addons`, `/subscriptions/:id/addons/basket` | Add / set add-on bundles |
| DELETE | `/subscriptions/:id/addons/:bundleId` | Remove an add-on bundle |
| POST | `/subscriptions/:id/discounts/preview`, `/subscriptions/:id/discounts` | Preview / redeem a discount code |
| DELETE | `/subscriptions/:id/discounts/:discountId` | Remove a discount |
| GET | `/summary`, `/summary/allocation`, `/summary/usage-by-team`, `/invoices`, `/events` | Billing dashboard: ledger totals, cost allocation, per-team usage, invoices, billing events |
| GET | `/offers` | The account's live expansion offer |
| POST | `/offers/:id/decline`, `/offers/:id/dismiss` | Decline / dismiss an offer |
| GET | `/support-incidents` | The account's one-time support-incident balance (`messages:read`) |

**Providers** (no user auth unless noted)

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/stripe/webhook` | Stripe event receiver (signature verified) |
| POST | `/marketplace/resolve` | AWS Marketplace registration redirect |
| POST | `/marketplace/claim` | Bind a resolved registration to the caller's org (`billing:manage`) |
| POST | `/marketplace/sns` | AWS Marketplace license events via SNS (signature + topic verified) |
| GET | `/marketplace/entitlements` | Current marketplace entitlements (`billing:read`) |

**Internal** (named service callers only)

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/internal/support-incidents/:orgId/consume`, `/internal/support-incidents/:orgId/refund` | Spend / refund one support incident (message service) |
| POST | `/internal/orgs/:orgId/purge` | Org-purge cascade leg: provider-cancel, then drop, the org's subscriptions + events; a failed cancel keeps the row and reports it in `remaining` (platform) |

**System org** (system-org permissions)

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/admin/subscriptions` | List all subscriptions |
| PUT | `/admin/subscriptions/:id` | Override plan / status / interval |
| PUT | `/admin/subscriptions/:id/support-floor` | Set a negotiated support-floor override |
| GET | `/subscriptions/by-org/:orgId/billable` | Whether an org still holds a billable subscription (org-move guard) |
| DELETE | `/subscriptions/by-org/:orgId` | The admin "Purge": provider-cancel, then delete, an org's subscriptions + events (step-up) |
| GET | `/admin/events`, `/admin/summary` | Billing events and ledger totals across orgs |
| * | `/admin/discounts…`, `/admin/promotions…`, `/admin/campaigns…` | Discount, promotion and campaign management (`billing:operate`) |
| * | `/admin/offers…` | Offer history, exclusions, withdraw, manual trigger |
| POST | `/admin/orgs/:orgId/support-incidents` | Grant support incidents |

## Configuration

The core settings are below. Feature switches and tuning knobs (bundles, discounts, promotions, offers, support floor, Stripe tax, webhook lease TTL and others) are listed in [docs/environment-variables.md](../../docs/environment-variables.md).

| Variable | Purpose | Default |
|----------|---------|---------|
| `PORT` | HTTP listen port | `3000` |
| `BILLING_ENABLED` | Enable the service (`false` returns `503` for every route but `/billing/config`) | `true` |
| `BILLING_PROVIDER` | Payment provider: `stub`, `stripe`, `aws-marketplace` | `stub` |
| `MONGODB_URI` | MongoDB connection string (required when enabled) | — |
| `PAYMENT_GRACE_PERIOD_DAYS` | Days before downgrading after a failed payment | `7` |
| `RENEWAL_REMINDER_DAYS` | Days before renewal to send a reminder | `7` |
| `BILLING_LIFECYCLE_CHECK_INTERVAL_MS` | Lifecycle checker interval | `3600000` |
| `BILLING_USAGE_FALLBACK_DAYS` | Window (days) used for usage rollups when no subscription period is known | `30` |
| `CACHE_TTL_BILLING_PLANS_SECONDS` | Plan catalog cache TTL (seconds) | `14400` |
| `QUOTA_SERVICE_HOST` / `QUOTA_SERVICE_PORT` | Quota service location for tier sync / usage | `quota` / `3000` |
| `MESSAGE_SERVICE_HOST` / `MESSAGE_SERVICE_PORT` | Message service location for notifications | `message` / `3000` |
| `STRIPE_SECRET_KEY` | Stripe API secret key | — |
| `STRIPE_WEBHOOK_SECRET` | Stripe webhook signing secret | — |
| `STRIPE_PRICE_MAP` | JSON map of `{planId}_{interval}` → Stripe Price ID | `{}` |
| `AWS_MARKETPLACE_PRODUCT_CODE` | AWS Marketplace product code | — |
| `AWS_MARKETPLACE_REGION` | Marketplace region (falls back to `AWS_REGION`) | `us-east-1` |
| `AWS_MARKETPLACE_EVENTS_TOPIC_ARN` | SNS topic carrying AWS Marketplace license events from EventBridge — the only topic the webhook accepts (set by the EKS deploy) | — |
| `AWS_MARKETPLACE_DIMENSION_MAP` | JSON map of marketplace dimensions → plan IDs | developer/pro/team/enterprise |
| `AWS_MARKETPLACE_BUNDLE_DIMENSION_MAP` | JSON map of add-on bundle IDs → metered dimension keys (BatchMeterUsage) | identity (bundle ID = dimension) |
| `BILLING_METERING_ENABLED` | Run the Marketplace add-on metering cycle (BatchMeterUsage) | `false` |
| `BILLING_METERING_INTERVAL_MS` | Metering cycle interval (ms) | `3600000` (1h) |

## Development

Builds on the shared core packages (`@pipeline-builder/api-core`, `@pipeline-builder/api-server`, `@pipeline-builder/pipeline-core`). Project files are generated by projen from `.projenrc.ts`.

```sh
pnpm build   # compile + lint + test
pnpm test    # run tests
pnpm start   # run the compiled service (node lib/index.js)
```

## License

Apache-2.0
