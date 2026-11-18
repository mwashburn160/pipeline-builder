// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Contract tests for the internal endpoints quota SERVES (api-core
 * `QUOTA_INTERNAL`): each is mounted at its contract's method + path with the
 * contract's callers, and a sample request/response round-trips its schemas.
 * The table is built exactly as `route-coverage.test.ts` builds it.
 */

import { describe, it, expect, beforeAll } from '@jest/globals';
import { QUOTA_INTERNAL, buildRouteTable, internalContractsServedBy, type RouteTableEntry } from '@pipeline-builder/api-core';
import { findContractMountViolations, roundTripContractSample, type ContractSample } from '@pipeline-builder/api-core/testing';

process.env.JWT_SECRET ||= 'internal-contracts-test-secret';
process.env.MONGODB_URI ||= 'mongodb://localhost:27017/internal-contracts-test';

const SAMPLES: Record<keyof typeof QUOTA_INTERNAL, ContractSample> = {
  usageProfile: {
    params: { orgId: 'org-1' },
    response: {
      profile: {
        orgId: 'org-1',
        tier: 'pro',
        rootOrgId: 'org-1',
        noticesEnabled: true,
        offersEnabled: false,
        dimensions: {
          apiCalls: { used: 50, limit: 100, ratio: 0.5, projected: 90, resetAt: '2026-12-01T00:00:00.000Z', periodDays: 30 },
          plugins: { used: 2, limit: -1, ratio: null, projected: null, resetAt: null, periodDays: null },
        },
      },
    },
  },
  purgeOrg: {
    params: { orgId: 'org-1' },
    response: { orgId: 'org-1', tables: { organizations: 1 } },
  },
};

let table: RouteTableEntry[];

beforeAll(async () => {
  const [{ createApp }, { mountRoutes }] = await Promise.all([
    import('@pipeline-builder/api-server'),
    import('../src/app-routes.js'),
  ]);
  const { app } = createApp({ enableOpenApi: false });
  mountRoutes(app);
  table = buildRouteTable(app);
});

describe('quota internal endpoint contracts', () => {
  it('has a sample for every contract quota serves', () => {
    expect(internalContractsServedBy('quota').map((c) => c.id).sort())
      .toEqual(Object.values(QUOTA_INTERNAL).map((c) => c.id).sort());
  });

  it.each(Object.entries(QUOTA_INTERNAL))('%s: mounted as declared and round-trips a sample', (name, contract) => {
    expect(findContractMountViolations(table, contract)).toEqual([]);
    const sample = SAMPLES[name as keyof typeof QUOTA_INTERNAL];
    expect(() => roundTripContractSample(contract, sample)).not.toThrow();
  });
});
