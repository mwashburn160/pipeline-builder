// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Contract tests for the internal endpoints reporting SERVES (api-core
 * `REPORTING_INTERNAL`): each is mounted at its contract's method + path with the
 * contract's callers, and a sample request/response round-trips its schemas.
 * The table is built exactly as `route-coverage.test.ts` builds it.
 */

import { describe, it, expect, beforeAll } from '@jest/globals';
import { REPORTING_INTERNAL, buildRouteTable, internalContractsServedBy, type RouteTableEntry } from '@pipeline-builder/api-core';
import { findContractMountViolations, roundTripContractSample, type ContractSample } from '@pipeline-builder/api-core/testing';

process.env.JWT_SECRET ||= 'internal-contracts-test-secret';

const SAMPLES: Record<keyof typeof REPORTING_INTERNAL, ContractSample> = {
  purgeOrg: { params: { orgId: 'org-1' }, response: { orgId: 'org-1', tables: { report_runs: 2 } } },
};

let table: RouteTableEntry[];

beforeAll(async () => {
  const [{ createApp }, { createQuotaService }, { mountRoutes }] = await Promise.all([
    import('@pipeline-builder/api-server'),
    import('@pipeline-builder/api-core'),
    import('../src/app-routes.js'),
  ]);
  const { app, sseManager } = createApp({ enableOpenApi: false });
  // The ticket store's backing Redis is irrelevant to the route table.
  const executionTicketStore = { issue: async () => ({ ok: true as const, ticket: 't' }), consume: async () => null, bindOwner: async () => undefined, getOwner: async () => null, stop: () => undefined };
  mountRoutes(app, { quotaService: createQuotaService(), sseManager, executionTicketStore });
  table = buildRouteTable(app);
});

describe('reporting internal endpoint contracts', () => {
  it('has a sample for every contract reporting serves', () => {
    expect(internalContractsServedBy('reporting').map((c) => c.id).sort())
      .toEqual(Object.values(REPORTING_INTERNAL).map((c) => c.id).sort());
  });

  it.each(Object.entries(REPORTING_INTERNAL))('%s: mounted as declared and round-trips a sample', (name, contract) => {
    expect(findContractMountViolations(table, contract)).toEqual([]);
    expect(() => roundTripContractSample(contract, SAMPLES[name as keyof typeof REPORTING_INTERNAL])).not.toThrow();
  });

  it('refuses a purge with no org id (the route answers 400, never a purge of everything)', () => {
    expect(REPORTING_INTERNAL.purgeOrg.params.safeParse({ orgId: '' }).success).toBe(false);
  });
});
