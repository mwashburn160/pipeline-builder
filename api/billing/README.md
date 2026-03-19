# Billing Service

Subscription management, plan catalog, and payment processing for the pipeline-builder platform.

## Providers

| Provider | Env `BILLING_PROVIDER` | Description |
|----------|----------------------|-------------|
| `stub` (default) | `stub` | Mock provider for local development |
| `stripe` | `stripe` | Stripe subscriptions + webhooks |
| `aws-marketplace` | `aws-marketplace` | AWS Marketplace SaaS integration |

## Endpoints

### Public (no auth)
- `GET /billing/plans` — List active plans (cached 4h)
- `GET /billing/plans/:planId` — Get plan details

### Authenticated
- `GET /billing/subscriptions` — Get org's active subscription
- `POST /billing/subscriptions` — Create subscription (admin)
- `PUT /billing/subscriptions/:id` — Change plan/interval (admin)
- `POST /billing/subscriptions/:id/cancel` — Cancel at period end (admin)
- `POST /billing/subscriptions/:id/reactivate` — Undo cancellation (admin)

### System Admin
- `GET /billing/admin/subscriptions` — List all subscriptions
- `PUT /billing/admin/subscriptions/:id` — Override subscription
- `GET /billing/admin/events` — List billing events

### Webhooks
- `POST /billing/stripe/webhook` — Stripe event receiver (signature verified)
- `POST /billing/marketplace/sns` — AWS Marketplace SNS notifications

## Payment Failure & Grace Period

When a payment fails, the subscription moves to `past_due` but the org **keeps their current tier** for a configurable grace period (default 7 days). Stripe retries the payment automatically. If the grace period expires without a successful payment, the org is downgraded to the `developer` tier.

| Event | Behavior |
|-------|----------|
| `invoice.payment_failed` | Status → `past_due`, grace period starts |
| `invoice.payment_succeeded` | Status → `active`, grace period resets, period advances |
| Grace period expires | Tier downgraded to `developer` |
| `customer.subscription.deleted` | Status → `canceled`, tier → `developer` |

## Subscription Lifecycle Checker

A background job runs every hour (configurable) to:

1. **Grace period expiry** — Downgrade orgs past their grace period
2. **Expired subscription detection** — Flag `active` subscriptions past `currentPeriodEnd` (missed webhooks)
3. **Renewal reminders** — Send a message N days before renewal

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `BILLING_ENABLED` | `true` | Enable/disable the billing service |
| `BILLING_PROVIDER` | `stub` | Payment provider (`stub`, `stripe`, `aws-marketplace`) |
| `MONGODB_URI` | — | MongoDB connection string (required when enabled) |
| `PAYMENT_GRACE_PERIOD_DAYS` | `7` | Days before downgrading after payment failure |
| `RENEWAL_REMINDER_DAYS` | `7` | Days before renewal to send notification |
| `BILLING_LIFECYCLE_CHECK_INTERVAL_MS` | `3600000` | Background checker interval (ms) |
| `STRIPE_SECRET_KEY` | — | Stripe API secret key |
| `STRIPE_WEBHOOK_SECRET` | — | Stripe webhook signing secret |
