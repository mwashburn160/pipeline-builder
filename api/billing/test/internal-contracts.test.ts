// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Contract tests for the internal endpoints billing SERVES (api-core
 * `BILLING_INTERNAL`): each is mounted at its contract's method + path with the
 * contract's callers, and a sample request/response round-trips its schemas.
 * The table is built exactly as `route-coverage.test.ts` builds it.
 */

import { describe, it, expect, beforeAll } from '@jest/globals';
import { BILLING_INTERNAL, buildRouteTable, internalContractsServedBy, type RouteTableEntry } from '@pipeline-builder/api-core';
import { findContractMountViolations, roundTripContractSample, type ContractSample } from '@pipeline-builder/api-core/testing';

process.env.JWT_SECRET ||= 'internal-contracts-test-secret';
process.env.BILLING_ENABLED = 'true';
process.env.MONGODB_URI ||= 'mongodb://127.0.0.1:27017/billing-internal-contracts';

const SAMPLES: Record<keyof typeof BILLING_INTERNAL, ContractSample> = {
  consumeSupportIncident: {
    params: { orgId: 'org-1' },
    body: { idempotencyKey: 'case-key-0001' },
    response: { consumed: true, remaining: 2 },
  },
  refundSupportIncident: {
    params: { orgId: 'org-1' },
    body: { idempotencyKey: 'case-key-0001' },
    response: { refunded: false, balance: null },
  },
};

let table: RouteTableEntry[];

beforeAll(async () => {
  const [{ createApp }, { mountRoutes }] = await Promise.all([
    import('@pipeline-builder/api-server'),
    import('../src/app-routes.js'),
  ]);
  const { app } = createApp({ enableOpenApi: false, jsonBodyExclude: ['/billing/stripe/webhook'] });
  mountRoutes(app);
  table = buildRouteTable(app);
});

describe('billing internal endpoint contracts', () => {
  it('has a sample for every contract billing serves', () => {
    expect(internalContractsServedBy('billing').map((c) => c.id).sort())
      .toEqual(Object.values(BILLING_INTERNAL).map((c) => c.id).sort());
  });

  it.each(Object.entries(BILLING_INTERNAL))('%s: mounted as declared and round-trips a sample', (name, contract) => {
    expect(findContractMountViolations(table, contract)).toEqual([]);
    const sample = SAMPLES[name as keyof typeof BILLING_INTERNAL];
    expect(() => roundTripContractSample(contract, sample)).not.toThrow();
  });

  it('rejects a malformed idempotency key with the route\'s own message', () => {
    const parsed = BILLING_INTERNAL.consumeSupportIncident.body!.safeParse({ idempotencyKey: 'short' });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.message).toBe('idempotencyKey must be 8-128 characters of [A-Za-z0-9_-]');
  });
});
