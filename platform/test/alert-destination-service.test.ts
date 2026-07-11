// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for `alertDestinationService.listAllAcrossOrgs` — the sysadmin
 * cross-tenant viewer query.
 *
 * The test asserts the right Drizzle predicate is built (filter on
 * `deletedAt IS NULL`, ordered by orgId then label) and that the query
 * runs inside a `withTenantTx` so it inherits the caller's RLS context.
 */

import { jest, describe, it, expect, beforeEach, test } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';
const mockOrderBy = jest.fn().mockReturnValue(Promise.resolve([]));
const mockWhere = jest.fn(() => ({ orderBy: mockOrderBy }));
const mockFrom = jest.fn(() => ({ where: mockWhere }));
const mockSelect = jest.fn(() => ({ from: mockFrom }));
const mockWithTenantTx = jest.fn(async (fn: (tx: unknown) => unknown) => fn({ select: mockSelect }));

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock());

jest.unstable_mockModule('@pipeline-builder/pipeline-data', () => ({
  schema: {
    orgAlertDestination: {
      orgId: 'orgId-col',
      label: 'label-col',
      deletedAt: 'deletedAt-col',
      enabled: 'enabled-col',
      id: 'id-col',
      minSeverity: 'minSev-col',
    },
  },
  withTenantTx: (fn: (tx: unknown) => unknown) => mockWithTenantTx(fn),
}));

jest.unstable_mockModule('drizzle-orm', () => ({
  and: (...conds: unknown[]) => ({ and: conds }),
  asc: (col: unknown) => ({ asc: col }),
  eq: (col: unknown, v: unknown) => ({ eq: [col, v] }),
  isNull: (col: unknown) => ({ isNull: col }),
  sql: (() => undefined) as unknown,
}));

const { alertDestinationService } = await import('../src/services/alert-destination-service.js');


beforeEach(() => {
  mockOrderBy.mockClear().mockReturnValue(Promise.resolve([]));
  mockWhere.mockClear();
  mockFrom.mockClear();
  mockSelect.mockClear();
  mockWithTenantTx.mockClear();
});

describe('alertDestinationService.listAllAcrossOrgs', () => {
  it('runs inside withTenantTx so it inherits caller RLS context', async () => {
    await alertDestinationService.listAllAcrossOrgs();
    expect(mockWithTenantTx).toHaveBeenCalledTimes(1);
  });

  it('filters on deletedAt IS NULL and orders by orgId then label', async () => {
    await alertDestinationService.listAllAcrossOrgs();

    // The predicate is: where(isNull(deletedAt)); orderBy(asc(orgId), asc(label))
    const whereCalls = mockWhere.mock.calls as unknown as Array<Array<{ isNull?: string }>>;
    expect(whereCalls[0][0]).toEqual({ isNull: 'deletedAt-col' });

    const orderCalls = mockOrderBy.mock.calls as unknown as Array<Array<{ asc?: string }>>;
    expect(orderCalls[0]).toEqual([{ asc: 'orgId-col' }, { asc: 'label-col' }]);
  });

  it('returns whatever the underlying query resolves to', async () => {
    const rows = [
      { id: 'd1', orgId: 'org-a', target: 't1', label: 'L1' },
      { id: 'd2', orgId: 'org-b', target: 't2', label: 'L2' },
    ];
    mockOrderBy.mockReturnValueOnce(Promise.resolve(rows));
    const result = await alertDestinationService.listAllAcrossOrgs();
    expect(result).toEqual(rows);
  });
});
