// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Permission + audit coverage for every route this service serves.
 *
 * Builds the REAL route table from `src/app-routes.ts` (the same mount code
 * `index.ts` runs) and fails when a write route has no permission gate or no
 * declared audit action, or a read route has no permission gate. Exceptions are
 * explicit and carry a reason; a stale one fails the test too.
 *
 * Billing is deployment-optional, so the table is built in its ENABLED shape
 * (BILLING_ENABLED=true) — the disabled deployment serves only `/billing/config`
 * plus a 503 catch-all, which is a strict subset.
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll } from '@jest/globals';
import { buildRouteTable, REMOTE_AUDIT_ACTIONS, type RouteTableEntry } from '@pipeline-builder/api-core';
import {
  INFRA_ROUTE_EXCEPTIONS,
  compareRouteTableSnapshot,
  declaredAuditActions,
  findRouteCoverageViolations,
  type RouteCoverageException,
} from '@pipeline-builder/api-core/testing';

process.env.JWT_SECRET ||= 'route-coverage-test-secret';
// `src/config.js` throws when billing is enabled without a Mongo URI, and the
// enabled shape is the one whose coverage matters (see the file comment).
process.env.BILLING_ENABLED = 'true';
process.env.MONGODB_URI ||= 'mongodb://127.0.0.1:27017/billing-route-coverage';

const here = dirname(fileURLToPath(import.meta.url));
const snapshotFile = resolve(here, '../../../frontend/src/generated/route-table/billing.json');

/** Routes that legitimately can't satisfy a rule, each with its reason. */
const EXCEPTIONS: RouteCoverageException[] = [
  ...INFRA_ROUTE_EXCEPTIONS,
  {
    method: 'GET',
    path: '/billing/config',
    waive: 'permission',
    reason: 'Deployment-config probe served in BOTH enabled and disabled mode so the frontend can hide the Billing nav; returns only the enabled flag + provider name (no secrets, no DB read).',
  },
  {
    method: 'GET',
    path: '/billing/plans',
    waive: 'permission',
    reason: 'Public plan catalog — the signup/pricing plan picker reads it before any account, org or permission exists. Returns active non-unlimited plan projections only.',
  },
  {
    method: 'GET',
    path: '/billing/plans/:planId',
    waive: 'permission',
    reason: 'Same public plan catalog as GET /billing/plans (single-plan lookup for the pre-auth picker).',
  },
  {
    method: 'POST',
    path: '/billing/subscriptions/checkout',
    waive: 'audit',
    reason: 'Mints a provider-hosted Checkout URL; nothing is persisted locally — the subscription (and its billing.subscription.create audit) is written by the customer.subscription.created webhook.',
  },
  {
    method: 'POST',
    path: '/billing/portal',
    waive: 'audit',
    reason: 'Mints a provider-hosted payment-method portal URL; no local state changes.',
  },
  {
    method: 'POST',
    path: '/billing/subscriptions/:id/addons/preview',
    waive: 'audit',
    reason: 'Dry run: computes effective limits + price for a hypothetical bundle change and persists nothing.',
  },
  {
    method: 'POST',
    path: '/billing/subscriptions/:id/discounts/preview',
    waive: 'audit',
    reason: 'Dry run: resolves a code and computes the price breakdown without redeeming it.',
  },
  {
    method: 'POST',
    path: '/billing/admin/discounts/:id/preview',
    waive: 'audit',
    reason: 'Sysadmin dry run of a discount against a target org; nothing is applied or persisted.',
  },
  {
    method: 'POST',
    path: '/billing/admin/promotions/:id/preview',
    waive: 'audit',
    reason: 'Projects a promotion\'s reach + committed spend; no grant is written.',
  },
  {
    method: 'POST',
    path: '/billing/marketplace/resolve',
    waive: 'all',
    reason: 'AWS Marketplace registration redirect — unauthenticated by contract (no account exists yet). Authorization is the AWS-signed registration token exchanged via resolveRegistrationToken; it only banks a short-lived single-use pending ref, and the audited bind happens in POST /marketplace/claim.',
  },
  {
    method: 'POST',
    path: '/billing/marketplace/sns',
    waive: 'all',
    reason: 'AWS SNS webhook — the handler verifies the SNS message signature (verifySNSSignature) and fails closed unless TopicArn is in the configured allow-list.',
  },
  {
    method: 'POST',
    path: '/billing/stripe/webhook',
    waive: 'all',
    reason: 'Stripe webhook — the handler verifies the HMAC signature over the raw body (stripe.webhooks.constructEvent) and 503s when no webhook secret is configured.',
  },
];

let table: RouteTableEntry[];

beforeAll(async () => {
  const [{ createApp }, { mountRoutes }] = await Promise.all([
    import('@pipeline-builder/api-server'),
    import('../src/app-routes.js'),
  ]);
  // Same options index.ts passes that affect routing: the Stripe webhook keeps
  // the raw body (jsonBodyExclude) and the docs routes stay off.
  const { app } = createApp({ enableOpenApi: false, jsonBodyExclude: ['/billing/stripe/webhook'] });
  mountRoutes(app);
  table = buildRouteTable(app);
});

describe('billing route coverage', () => {
  it('serves a non-empty route table', () => {
    expect(table.length).toBeGreaterThan(0);
  });

  it('gates every write route on a permission and declares its audit action', () => {
    const { violations } = findRouteCoverageViolations(table, EXCEPTIONS);
    expect(violations).toEqual([]);
  });

  it('has no stale coverage exceptions', () => {
    const { unusedExceptions } = findRouteCoverageViolations(table, EXCEPTIONS);
    expect(unusedExceptions).toEqual([]);
  });

  it('declares only audit actions platform accepts from a service', () => {
    const unknown = declaredAuditActions(table).filter((a) => !(REMOTE_AUDIT_ACTIONS as readonly string[]).includes(a));
    expect(unknown).toEqual([]);
  });

  it('matches the route table the frontend reads', () => {
    expect(compareRouteTableSnapshot(table, snapshotFile)).toBeNull();
  });
});
