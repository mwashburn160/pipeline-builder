// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The org policy "administrative actions require MFA" reaches billing.
 *
 * Billing can't read the org document, so the policy arrives as the
 * `org_admin_aal` token claim and `requireOrgAdminAssurance` enforces it. This
 * pins WHICH routes carry the gate (every write that changes what the org pays
 * for) and that billing automation (machine credentials) is still admitted on
 * them — built from the real route table, the same one the frontend reads.
 */

import { describe, it, expect, beforeAll } from '@jest/globals';
import { buildRouteTable, isWriteMethod, type RouteTableEntry } from '@pipeline-builder/api-core';

process.env.JWT_SECRET ||= 'route-coverage-test-secret';
process.env.BILLING_ENABLED = 'true';
process.env.MONGODB_URI ||= 'mongodb://127.0.0.1:27017/billing-route-coverage';

/**
 * Writes that change WHAT THE ORG PAYS FOR. These carry the MFA gate.
 */
const GATED = [
  'POST /billing/subscriptions/checkout',
  'POST /billing/subscriptions',
  'PUT /billing/subscriptions/:id',
  'POST /billing/subscriptions/:id/cancel',
  'POST /billing/subscriptions/:id/reactivate',
  'POST /billing/portal',
  'POST /billing/subscriptions/:id/addons',
  // A basket is a purchase of several add-ons under ONE confirmation, so it
  // belongs here beside the single add rather than being a quieter way to buy
  // the same things (docs/plans/sales-agent.md F6).
  'POST /billing/subscriptions/:id/addons/basket',
  'DELETE /billing/subscriptions/:id/addons/:bundleId',
  'POST /billing/subscriptions/:id/discounts',
  'DELETE /billing/subscriptions/:id/discounts/:discountId',
  'POST /billing/marketplace/claim',
].sort();

/**
 * `billing:manage` writes that change NOTHING the org pays — the only such
 * routes in this service, and the reason the lists below are two rather than one.
 *
 * Answering an expansion offer is an account-level COMMUNICATIONS decision, not
 * a commercial one: declining lengthens the quiet period and dismissing hides a
 * card, and neither moves a single cent. Demanding an MFA step-up to click "No
 * thanks" would be the wrong trade — it would push accounts into ignoring the
 * card instead of answering it, and "never saw it" versus "said no" is the
 * single most valuable distinction the outcome log measures (D12).
 *
 * They still need `billing:manage` (a decline suppresses offers for the WHOLE
 * account for months, which is more than a reader should decide) and they still
 * refuse a team org, which is why they appear in the team-guard list below.
 *
 * Enumerated rather than skipped: a NEW `billing:manage` write still fails this
 * suite until someone classifies it, which is the property worth keeping.
 */
const NON_PAYMENT_MANAGE_WRITES = [
  'POST /billing/offers/:id/decline',
  'POST /billing/offers/:id/dismiss',
].sort();

/** Every write that must refuse a team (child) org: billing is account-scoped. */
const TEAM_GUARDED = [...GATED, ...NON_PAYMENT_MANAGE_WRITES].sort();

let table: RouteTableEntry[];
let teamGuarded: string[];
let refuseTeamBillingFn: unknown;

/** Every `METHOD /path` whose route stack carries `fn` (walks mounted routers). */
function routesCarrying(app: unknown, fn: unknown): string[] {
  const out: string[] = [];
  const walk = (stack: any[], prefix: string): void => {
    for (const layer of stack) {
      if (layer.route) {
        const full = `${prefix}${layer.route.path}`.replace(/\/+/g, '/');
        if (layer.route.stack.some((l: any) => l.handle === fn)) {
          for (const m of Object.keys(layer.route.methods)) out.push(`${m.toUpperCase()} ${full}`);
        }
      } else if (layer.handle && Array.isArray(layer.handle.stack)) {
        walk(layer.handle.stack, `${prefix}${layer[Symbol.for('pipeline-builder.layer-path')] ?? ''}`);
      }
    }
  };
  walk((app as any).router.stack, '');
  return out.sort();
}

beforeAll(async () => {
  const [{ createApp }, { mountRoutes }, guard] = await Promise.all([
    import('@pipeline-builder/api-server'),
    import('../src/app-routes.js'),
    import('../src/helpers/root-org-guard.js'),
  ]);
  refuseTeamBillingFn = guard.refuseTeamBilling;
  const { app } = createApp({ enableOpenApi: false, jsonBodyExclude: ['/billing/stripe/webhook'] });
  mountRoutes(app);
  table = buildRouteTable(app);
  teamGuarded = routesCarrying(app, refuseTeamBillingFn);
});

describe('billing admin-actions MFA gates', () => {
  it('gates exactly the org-side billing writes', () => {
    const gated = table.filter((e) => e.orgAdminAssurance).map((e) => `${e.method} ${e.path}`).sort();
    expect(gated).toEqual(GATED);
  });

  it('admits machine credentials on every one of them (billing automation is legitimate)', () => {
    for (const entry of table.filter((e) => e.orgAdminAssurance)) {
      expect({ route: `${entry.method} ${entry.path}`, machines: entry.orgAdminAssurance?.machines })
        .toEqual({ route: `${entry.method} ${entry.path}`, machines: 'allow' });
    }
  });

  it('classifies every billing:manage write — gated, or named as non-payment', () => {
    // The property this keeps: a new manage write cannot ship unclassified. It
    // either carries the MFA gate or is listed above with the reason it does not.
    const manageWrites = table
      .filter((e) => isWriteMethod(e.method) && e.permissions.some((p) => p.permissions.includes('billing:manage')))
      .map((e) => `${e.method} ${e.path}`);
    expect(manageWrites.filter((r) => !GATED.includes(r) && !NON_PAYMENT_MANAGE_WRITES.includes(r))).toEqual([]);
  });

  it('keeps the non-payment carve-out honest: none of them is a payment write', () => {
    // The carve-out is only safe while it stays empty of anything commercial, so
    // the list is checked against the gate rather than merely trusted.
    expect(NON_PAYMENT_MANAGE_WRITES.filter((r) => GATED.includes(r))).toEqual([]);
    for (const route of NON_PAYMENT_MANAGE_WRITES) {
      const entry = table.find((e) => `${e.method} ${e.path}` === route);
      expect({ route, found: Boolean(entry), assurance: entry?.orgAdminAssurance ?? null })
        .toEqual({ route, found: true, assurance: null });
    }
  });

  it('refuses team (child) orgs on every account-scoped billing write', () => {
    expect(teamGuarded).toEqual(TEAM_GUARDED);
  });
});
