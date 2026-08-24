// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * One-shot Stripe Price provisioning for a fresh install (finding G1).
 *
 * The billing service looks up a Stripe Price id per `<planOrBundleId>_<interval>`
 * in `STRIPE_PRICE_MAP` and THROWS on the first subscribe if a paid plan/bundle is
 * unmapped. Stripe Prices are immutable, so a fresh Stripe install (or any price
 * change) must create new Price objects and repopulate the map. This script reads
 * the EFFECTIVE billing config (so env overrides are honoured) and creates a Price
 * per interval for every paid plan and every chargeable add-on bundle, then prints
 * the ready-to-paste `STRIPE_PRICE_MAP` JSON. Combos are customer-balance credits
 * (not line items) and need no Price; $0 plans (developer/unlimited) are skipped.
 *
 * Usage (from api/billing, where `stripe` + the workspace package resolve):
 *   STRIPE_SECRET_KEY=sk_test_... node scripts/provision-stripe-prices.mjs [--dry-run]
 *
 * Re-running creates NEW Price objects (Stripe prices are immutable) — run it once
 * per fresh install / intentional price change, then set STRIPE_PRICE_MAP.
 */
import Stripe from 'stripe';
// `loadBillingConfig` isn't a package-root export; reach it via the deep path
// (the package's exports map exposes `./lib/*`).
import { loadBillingConfig } from '@pipeline-builder/pipeline-core/lib/config/billing-config.js';

const dryRun = process.argv.includes('--dry-run');
const key = process.env.STRIPE_SECRET_KEY;
if (!key && !dryRun) {
  console.error('STRIPE_SECRET_KEY is required (or pass --dry-run to preview).');
  process.exit(1);
}

const stripe = key ? new Stripe(key) : null;
const { plans, bundles } = loadBillingConfig();

/** Every chargeable item: paid plans (price > 0) + all add-on bundles. */
const items = [
  ...plans.filter((p) => p.prices.monthly > 0).map((p) => ({ id: p.id, name: p.name, prices: p.prices })),
  ...bundles.map((b) => ({ id: b.id, name: b.name, prices: b.prices })),
];

const map = {};
for (const item of items) {
  for (const [interval, recurring] of [['monthly', 'month'], ['annual', 'year']]) {
    const cents = item.prices[interval];
    if (!cents || cents <= 0) continue;
    const label = `${item.id}_${interval}`;
    if (dryRun) {
      console.error(`[dry-run] would create ${label}: ${item.name} $${(cents / 100).toFixed(2)}/${recurring}`);
      map[label] = `price_DRYRUN_${label}`;
      continue;
    }
    const price = await stripe.prices.create({
      currency: 'usd',
      unit_amount: cents,
      recurring: { interval: recurring },
      product_data: { name: item.name },
      metadata: { pb_id: item.id, pb_interval: interval },
    });
    console.error(`created ${label}: ${price.id} (${item.name} $${(cents / 100).toFixed(2)}/${recurring})`);
    map[label] = price.id;
  }
}

// The map goes to stdout so it can be redirected/piped; progress goes to stderr.
console.log(JSON.stringify(map));
console.error(`\nSet STRIPE_PRICE_MAP to the JSON above (${Object.keys(map).length} prices).`);
