// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Contract tests for the internal endpoints ops-center SERVES (api-core
 * `OPS_CENTER_INTERNAL`): each is mounted at its contract's method + path
 * with the contract's callers, and a sample request/response round-trips its
 * schemas. The table is built exactly as `route-coverage.test.ts` builds it.
 */

import { describe, it, expect, beforeAll } from '@jest/globals';
import { OPS_CENTER_INTERNAL, buildRouteTable, internalContractsServedBy, type RouteTableEntry } from '@pipeline-builder/api-core';
import { findContractMountViolations, roundTripContractSample, type ContractSample } from '@pipeline-builder/api-core/testing';

process.env.JWT_SECRET ||= 'internal-contracts-test-secret';

const SAMPLES: Record<keyof typeof OPS_CENTER_INTERNAL, ContractSample> = {
  purgeOrg: { params: { orgId: 'org-1' }, response: { orgId: 'org-1', tables: { dashboards: 2, alert_destination_status: 1 } } },
};

let table: RouteTableEntry[];

beforeAll(async () => {
  const [{ createApp }, { mountRoutes }] = await Promise.all([
    import('@pipeline-builder/api-server'),
    import('../src/app-routes.js'),
  ]);
  const { app } = createApp({ enableOpenApi: false, enableRateLimit: false });
  mountRoutes(app);
  table = buildRouteTable(app);
});

describe('ops-center internal endpoint contracts', () => {
  it('has a sample for every contract ops-center serves', () => {
    expect(internalContractsServedBy('ops-center').map((c) => c.id).sort())
      .toEqual(Object.values(OPS_CENTER_INTERNAL).map((c) => c.id).sort());
  });

  it.each(Object.entries(OPS_CENTER_INTERNAL))('%s: mounted as declared and round-trips a sample', (name, contract) => {
    expect(findContractMountViolations(table, contract)).toEqual([]);
    expect(() => roundTripContractSample(contract, SAMPLES[name as keyof typeof OPS_CENTER_INTERNAL])).not.toThrow();
  });

  it('refuses a purge with no org id (the route answers 400, never a purge of everything)', () => {
    expect(OPS_CENTER_INTERNAL.purgeOrg.params.safeParse({ orgId: '' }).success).toBe(false);
  });
});
