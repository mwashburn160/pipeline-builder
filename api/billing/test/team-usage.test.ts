// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The per-team usage breakdown must report each org's OWN consumption.
 *
 * It used to read the pooled `GET /quotas/:orgId`, which for every member of an
 * org → team pool returns the ROOT's cap against the WHOLE subtree's usage — so
 * every team row printed the account total. It now reads the unpooled
 * `own-usage` snapshot; these tests pin that and the fail-soft row contract.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import type { AnyFn } from '@pipeline-builder/api-core/testing';
import { apiCoreMock } from './helpers/mock-api-core.js';

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock());

const fetchOwnQuotaSnapshot = jest.fn<AnyFn>();
const fetchQuotaSnapshot = jest.fn<AnyFn>();
const fetchSeatUsage = jest.fn<AnyFn>();
jest.unstable_mockModule('../src/helpers/downstream-client.js', () => ({
  fetchOwnQuotaSnapshot,
  fetchQuotaSnapshot,
  fetchSeatUsage,
}));
jest.unstable_mockModule('../src/helpers/billing-helpers.js', () => ({
  billingServiceAuth: (orgId: string) => `Bearer svc-${orgId}`,
}));

const { getTeamUsage } = await import('../src/helpers/team-usage.js');

beforeEach(() => {
  fetchOwnQuotaSnapshot.mockReset();
  fetchQuotaSnapshot.mockReset();
  fetchSeatUsage.mockReset();
});

describe('getTeamUsage', () => {
  it('reports each org\'s OWN usage, never the pooled total', async () => {
    const own: Record<string, number> = { 'root': 10, 'team-a': 3, 'team-b': 0 };
    fetchOwnQuotaSnapshot.mockImplementation(async (id: string) => ({
      name: id,
      quotas: { apiCalls: { used: own[id], limit: -1 } },
    }));
    fetchSeatUsage.mockResolvedValue({ used: 2, limit: 3 });

    const rows = await getTeamUsage(['root', 'team-a', 'team-b']);

    expect(rows.map((r) => [r.orgId, r.usage.apiCalls])).toEqual([['root', 10], ['team-a', 3], ['team-b', 0]]);
    expect(fetchQuotaSnapshot).not.toHaveBeenCalled();
    expect(fetchOwnQuotaSnapshot).toHaveBeenCalledWith('team-a', 'Bearer svc-team-a');
  });

  it('is fail-soft per org: an unreadable team yields nulls, not an exception', async () => {
    fetchOwnQuotaSnapshot.mockResolvedValue(null);
    fetchSeatUsage.mockResolvedValue(null);
    const [row] = await getTeamUsage(['team-a']);
    expect(row).toEqual({ orgId: 'team-a', name: undefined, seats: null, usage: {} });
  });
});
