// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Audit Activity panels over the MongoDB audit trail. The tenancy predicate is
 * the security-critical bit: an org admin's query must always carry the same
 * `orgId OR affectedOrgId` scope `GET /audit` applies, a sysadmin's must not,
 * and a non-sysadmin with no org must never reach Mongo unscoped.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';

const mockAggregate = jest.fn<(pipeline: any[]) => Promise<unknown[]>>();
const mockFindLimit = jest.fn<(n: number) => { lean: () => Promise<unknown[]> }>();
const mockFind = jest.fn<(q: any) => unknown>();

jest.unstable_mockModule('../src/models/audit-event.js', () => ({
  default: {
    aggregate: (pipeline: any[]) => mockAggregate(pipeline),
    find: (q: any) => mockFind(q),
  },
}));
// audit-service's write path pulls the hash-chain helper; the read builder doesn't need it.
jest.unstable_mockModule('../src/helpers/audit-chain.js', () => ({ appendAuditEvent: jest.fn() }));

const { queryAuditStore } = await import('../src/observability/audit-store-client.js');

const ORG_ADMIN = { isSuperAdmin: false, orgId: 'org-1' };
const SYSADMIN = { isSuperAdmin: true, orgId: 'system' };
// 2026-01-01T12:00:00Z — on an hour boundary so bucket math is easy to read.
const END = Date.UTC(2026, 0, 1, 12) / 1000;
const params = (over: Partial<Parameters<typeof queryAuditStore>[2]> = {}) =>
  ({ range: '1h' as const, end: END, limit: 50, vars: {}, ...over });

let recentDocs: unknown[] = [];

beforeEach(() => {
  jest.clearAllMocks();
  mockAggregate.mockResolvedValue([]);
  recentDocs = [];
  mockFindLimit.mockImplementation(() => ({ lean: async () => recentDocs }));
  mockFind.mockImplementation(() => ({ sort: () => ({ limit: mockFindLimit }) }));
});

const firstMatch = () => (mockAggregate.mock.calls[0][0] as Array<{ $match?: Record<string, unknown> }>)[0].$match!;

describe('tenancy scope', () => {
  it('confines an org admin to rows where their org acted or was acted on', async () => {
    await queryAuditStore('events_by_action', ORG_ADMIN, params());
    expect(firstMatch().$or).toEqual([{ orgId: 'org-1' }, { affectedOrgId: 'org-1' }]);
  });

  it('gives a sysadmin every org (no org predicate)', async () => {
    await queryAuditStore('top_actors_24h', SYSADMIN, params());
    expect(firstMatch()).not.toHaveProperty('$or');
    expect(firstMatch()).not.toHaveProperty('orgId');
  });

  it('returns nothing — without querying — for a non-sysadmin with no org', async () => {
    const noOrg = { isSuperAdmin: false };
    expect(await queryAuditStore('events_by_action', noOrg, params())).toEqual({ kind: 'matrix', series: [], step: '300s' });
    expect(await queryAuditStore('recent_events', noOrg, params())).toEqual({ kind: 'stream', entries: [] });
    expect(mockAggregate).not.toHaveBeenCalled();
    expect(mockFind).not.toHaveBeenCalled();
  });

  it('keeps the org scope when an actor filter adds its own $or', async () => {
    await queryAuditStore('recent_events', ORG_ADMIN, params({ vars: { actor: 'u@x.com', event: 'pipeline.delete', requestId: 'r-1' } }));
    const q = mockFind.mock.calls[0][0];
    expect(q.$or).toEqual([{ orgId: 'org-1' }, { affectedOrgId: 'org-1' }]);
    expect(q.$and).toEqual([{ $or: [{ actorId: 'u@x.com' }, { actorEmail: 'u@x.com' }] }]);
    expect(q.action).toBe('pipeline.delete');
    expect(q.requestId).toBe('r-1');
  });
});

describe('events_by_action', () => {
  it('buckets per range, zero-fills the window, and windows createdAt to the range', async () => {
    mockAggregate.mockResolvedValue([
      { _id: { action: 'pipeline.create', bucket: new Date((END - 600) * 1000) }, count: 3 },
    ]);
    const out = await queryAuditStore('events_by_action', ORG_ADMIN, params());
    expect(out.kind).toBe('matrix');
    if (out.kind !== 'matrix') return;
    expect(out.step).toBe('300s');
    const [series] = out.series;
    expect(series.labels).toEqual({ event: 'pipeline.create' });
    // 1h / 5m buckets, inclusive of both ends → 13 points, all but one zero.
    expect(series.values).toHaveLength(13);
    expect(series.values.find(v => v.time === END - 600)?.value).toBe('3');
    expect(series.values.filter(v => v.value === '0')).toHaveLength(12);
    expect(firstMatch().createdAt).toEqual({ $gte: new Date((END - 3600) * 1000), $lte: new Date(END * 1000) });
  });
});

describe('top_actors_24h', () => {
  it('ranks actors over a fixed 24h window, labelled by email when known', async () => {
    mockAggregate.mockResolvedValue([{ _id: 'u1', email: 'a@x.com', count: 7 }, { _id: 'svc', count: 2 }]);
    const out = await queryAuditStore('top_actors_24h', ORG_ADMIN, params({ range: '1h' }));
    expect(firstMatch().createdAt).toEqual({ $gte: new Date((END - 86_400) * 1000), $lte: new Date(END * 1000) });
    expect(out).toEqual({
      kind: 'matrix',
      step: '86400s',
      series: [
        { labels: { actor: 'a@x.com' }, values: [{ time: END, value: '7' }] },
        { labels: { actor: 'svc' }, values: [{ time: END, value: '2' }] },
      ],
    });
  });
});

describe('recent_events', () => {
  it('maps rows to table entries (unix-ms time, event/actor labels)', async () => {
    recentDocs = [{
      action: 'pipeline.delete',
      actorId: 'u1',
      actorEmail: 'a@x.com',
      outcome: 'failure',
      targetType: 'pipeline',
      targetId: 'p1',
      orgId: 'org-1',
      affectedOrgId: 'org-1',
      createdAt: new Date(1_767_268_800_123),
    }];
    const out = await queryAuditStore('recent_events', ORG_ADMIN, params({ limit: 25 }));
    expect(mockFindLimit).toHaveBeenCalledWith(25);
    expect(out).toEqual({
      kind: 'stream',
      entries: [{
        time: 1_767_268_800_123,
        line: 'pipeline:p1 FAILED',
        labels: { event: 'pipeline.delete', actor: 'a@x.com', outcome: 'failure', org_id: 'org-1' },
      }],
    });
  });
});
