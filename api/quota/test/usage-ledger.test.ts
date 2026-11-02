// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The usage ledger: fire-and-forget writes that never fail the increment, the
 * grouped read (scope follows pooling: root ∪ own), and the CSV export.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import type { AnyFn } from '@pipeline-builder/api-core/testing';
import { apiCoreMock } from './helpers/mock-api-core.js';

const emitCounter = jest.fn<AnyFn>();
jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({ emitCounter }));

const create = jest.fn<AnyFn>();
const aggregate = jest.fn<AnyFn>();
jest.unstable_mockModule('../src/models/usage-event.js', () => ({ UsageEvent: { create, aggregate } }));

const { recordUsageEvent, queryUsage, usageToCsv } = await import('../src/services/usage-ledger.js');

const flush = () => new Promise((r) => setImmediate(r));

beforeEach(() => {
  jest.clearAllMocks();
  create.mockResolvedValue({});
});

describe('recordUsageEvent', () => {
  it('writes the attributed row and counts the outcome', async () => {
    recordUsageEvent({
      orgId: 'team-a',
      rootOrgId: 'root',
      quotaType: 'automationCalls',
      amount: 1,
      outcome: 'counted',
      attribution: { principalType: 'service_account', principalId: 'sa-1', keyId: 'k-1', route: 'GET /plugins/:name', pipelineId: 'p-1', requestId: 'r-1' },
    });
    expect(emitCounter).toHaveBeenCalledWith('quota_increments_total', { type: 'automationCalls', outcome: 'counted' });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      orgId: 'team-a',
      rootOrgId: 'root',
      quotaType: 'automationCalls',
      amount: 1,
      outcome: 'counted',
      principalType: 'service_account',
      principalId: 'sa-1',
      keyId: 'k-1',
      route: 'GET /plugins/:name',
      pipelineId: 'p-1',
      requestId: 'r-1',
      at: expect.any(Date),
    }));
  });

  it('a failed write is counted, never thrown', async () => {
    create.mockRejectedValue(new Error('mongo down'));
    expect(() => recordUsageEvent({ orgId: 'o', rootOrgId: 'o', quotaType: 'apiCalls', amount: 1, outcome: 'denied' })).not.toThrow();
    await flush();
    expect(emitCounter).toHaveBeenCalledWith('quota_usage_event_write_failed_total', { type: 'apiCalls' });
  });
});

describe('queryUsage', () => {
  const from = new Date('2026-10-01T00:00:00Z');
  const to = new Date('2026-10-04T00:00:00Z');

  it('scopes to the account root OR the org itself, with type + time bounds', async () => {
    aggregate.mockResolvedValue([]);
    await queryUsage({ orgId: 'root', quotaType: 'apiCalls', from, to, groupBy: 'route' });
    const [pipeline] = aggregate.mock.calls[0] as [Array<Record<string, any>>];
    expect(pipeline[0].$match).toEqual({
      $or: [{ rootOrgId: 'root' }, { orgId: 'root' }],
      at: { $gte: from, $lt: to },
      quotaType: 'apiCalls',
    });
    expect(pipeline[1].$group._id).toBe('$route');
  });

  it('principal groups carry the principal type and a distinct-key count', async () => {
    aggregate.mockResolvedValue([
      { _id: { id: 'sa-1', type: 'service_account' }, counted: 10, denied: 2, refunded: 1, keys: ['k-1', 'k-2', null] },
      { _id: { id: null, type: null }, counted: 1, denied: 0, refunded: 0, keys: [] },
    ]);
    const groups = await queryUsage({ orgId: 'o', from, to, groupBy: 'principal' });
    expect(groups).toEqual([
      { key: 'sa-1', principalType: 'service_account', keyCount: 2, counted: 10, denied: 2, refunded: 1, net: 9 },
      { key: null, keyCount: 0, counted: 1, denied: 0, refunded: 0, net: 1 },
    ]);
  });

  it('day groups sort chronologically; a non-string key reads as unattributed', async () => {
    aggregate.mockResolvedValue([{ _id: '2026-10-01', counted: 4, denied: 0, refunded: 0 }, { _id: null, counted: 1, denied: 0, refunded: 2 }]);
    const groups = await queryUsage({ orgId: 'o', from, to, groupBy: 'day' });
    const [pipeline] = aggregate.mock.calls[0] as [Array<Record<string, any>>];
    expect(pipeline[2].$sort).toEqual({ _id: 1 });
    expect(groups).toEqual([
      { key: '2026-10-01', counted: 4, denied: 0, refunded: 0, net: 4 },
      { key: null, counted: 1, denied: 0, refunded: 2, net: 0 },
    ]);
  });
});

describe('usageToCsv', () => {
  it('writes a principal header and guards formula-looking cells', () => {
    const csv = usageToCsv('principal', [
      { key: '=HYPERLINK("x")', principalType: 'user', keyCount: 1, counted: 2, denied: 0, refunded: 0, net: 2 },
      { key: null, keyCount: 0, counted: 1, denied: 1, refunded: 0, net: 1 },
    ]);
    expect(csv.split('\n')).toEqual([
      'principal,principalType,keys,counted,denied,refunded,net',
      '"\'=HYPERLINK(""x"")",user,1,2,0,0,2',
      '(unattributed),,0,1,1,0,1',
    ]);
  });

  it('names the grouping column for the other groupings', () => {
    expect(usageToCsv('route', [
      { key: 'GET /a', counted: 1, denied: 0, refunded: 0, net: 1 },
      { key: null, counted: 2, denied: 0, refunded: 0, net: 2 },
    ])).toBe('route,counted,denied,refunded,net\nGET /a,1,0,0,1\n(unattributed),2,0,0,2');
  });

  it('a principal row with no type / key count still renders, and missing keys count as none', async () => {
    expect(usageToCsv('principal', [{ key: 'u', counted: 1, denied: 0, refunded: 0, net: 1 }])).toContain('\nu,,0,1,0,0,1');
    aggregate.mockResolvedValue([{ _id: null, counted: 1, denied: 0, refunded: 0 }]);
    const [g] = await queryUsage({ orgId: 'o', from: new Date(0), to: new Date(), groupBy: 'principal' });
    expect(g).toEqual({ key: null, keyCount: 0, counted: 1, denied: 0, refunded: 0, net: 1 });
  });
});
