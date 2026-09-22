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

const GATED = [
  'POST /billing/subscriptions/checkout',
  'POST /billing/subscriptions',
  'PUT /billing/subscriptions/:id',
  'POST /billing/subscriptions/:id/cancel',
  'POST /billing/subscriptions/:id/reactivate',
  'POST /billing/portal',
  'POST /billing/subscriptions/:id/addons',
  'DELETE /billing/subscriptions/:id/addons/:bundleId',
  'POST /billing/subscriptions/:id/discounts',
  'DELETE /billing/subscriptions/:id/discounts/:discountId',
  'POST /billing/marketplace/claim',
].sort();

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

  it('leaves every billing:manage write gated (no manage write escapes the policy)', () => {
    const manageWrites = table
      .filter((e) => isWriteMethod(e.method) && e.permissions.some((p) => p.permissions.includes('billing:manage')))
      .map((e) => `${e.method} ${e.path}`);
    expect(manageWrites.filter((r) => !GATED.includes(r))).toEqual([]);
  });

  it('refuses team (child) orgs on exactly the same billing writes', () => {
    expect(teamGuarded).toEqual(GATED);
  });
});
