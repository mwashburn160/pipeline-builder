// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { jest, describe, it, expect, beforeEach } from '@jest/globals';

// FIFO queues: each tx.select() consumes the next selectResults entry; each
// insert/update/delete .returning() consumes the next returningResults entry.
let selectResults: unknown[][] = [];
let returningResults: unknown[][] = [];

function shift(q: unknown[][]): unknown[] {
  return q.length ? (q.shift() as unknown[]) : [];
}

function makeChain(terminal: () => Promise<unknown[]>): Record<string, unknown> {
  const chain: Record<string, unknown> = {};
  for (const name of ['from', 'innerJoin', 'leftJoin', 'where', 'set', 'orderBy', 'limit', 'offset', 'values']) {
    chain[name] = jest.fn(() => chain);
  }
  chain.returning = jest.fn(() => Promise.resolve(shift(returningResults)));
  (chain as { then: unknown }).then = (resolve: (v: unknown[]) => unknown) => terminal().then(resolve);
  return chain;
}

const tx = {
  select: jest.fn(() => makeChain(() => Promise.resolve(shift(selectResults)))),
  insert: jest.fn(() => makeChain(() => Promise.resolve(shift(returningResults)))),
  update: jest.fn(() => makeChain(() => Promise.resolve(shift(returningResults)))),
};

const withTenantTx = jest.fn((cb: (t: typeof tx) => Promise<unknown>) => cb(tx));
const buildComplianceScanConditions = jest.fn((_filter: unknown, orgId: string) => [{ orgScoped: orgId }]);

jest.unstable_mockModule('@pipeline-builder/pipeline-data', () => ({
  schema: {
    complianceScan: {
      id: 'col_id',
      orgId: 'col_org',
      status: 'col_status',
      createdAt: 'col_created',
      target: 'col_target',
      filter: 'col_filter',
      triggeredBy: 'col_trig',
      userId: 'col_user',
      cancelledAt: 'col_cancelledAt',
      cancelledBy: 'col_cancelledBy',
    },
  },
  withTenantTx: (cb: (t: typeof tx) => Promise<unknown>) => withTenantTx(cb),
  drizzleCount: (r: unknown) => r,
  buildComplianceScanConditions: (f: unknown, o: string) => buildComplianceScanConditions(f, o),
}));

const { complianceScanService } = await import('../src/services/compliance-scan-service.js');

describe('ComplianceScanService', () => {
  beforeEach(() => {
    selectResults = [];
    returningResults = [];
    tx.select.mockClear();
    tx.insert.mockClear();
    tx.update.mockClear();
    withTenantTx.mockClear();
    buildComplianceScanConditions.mockClear();
  });

  describe('list', () => {
    it('org-scopes the query and returns scans + total', async () => {
      selectResults = [
        [{ count: 2 }], // count query
        [{ id: 's1' }, { id: 's2' }], // data query
      ];
      const result = await complianceScanService.list({ status: 'pending' }, 'org-1', 20, 0);
      // Tenancy: the caller's orgId is threaded into the condition builder.
      expect(buildComplianceScanConditions).toHaveBeenCalledWith({ status: 'pending' }, 'org-1');
      expect(result.total).toBe(2);
      expect(result.scans).toHaveLength(2);
    });

    it('defaults total to 0 when the count row is missing', async () => {
      selectResults = [[], []];
      const result = await complianceScanService.list({}, 'org-1', 20, 0);
      expect(result.total).toBe(0);
      expect(result.scans).toEqual([]);
    });
  });

  describe('findById', () => {
    it('returns the scan when found', async () => {
      selectResults = [[{ id: 's1', orgId: 'org-1' }]];
      const scan = await complianceScanService.findById('s1', 'org-1');
      expect(scan).toMatchObject({ id: 's1' });
    });

    it('returns null on a cross-tenant / missing id', async () => {
      selectResults = [[]];
      const scan = await complianceScanService.findById('s1', 'other-org');
      expect(scan).toBeNull();
    });
  });

  describe('create', () => {
    it('force-scopes the caller filter to the org and marks the scan pending/manual', async () => {
      returningResults = [[{ id: 's-new', status: 'pending', triggeredBy: 'manual' }]];
      const scan = await complianceScanService.create('org-1', 'u1', 'plugin', { orgId: 'evil-org', extra: 1 }, false);
      const values = (tx.insert.mock.results[0].value as { values: jest.Mock }).values;
      const inserted = values.mock.calls[0][0] as Record<string, unknown>;
      // Cross-tenant scan-triggering guard: the injected orgId is overwritten.
      expect((inserted.filter as Record<string, unknown>).orgId).toBe('org-1');
      expect(inserted.status).toBe('pending');
      expect(inserted.triggeredBy).toBe('manual');
      expect(scan).toMatchObject({ id: 's-new' });
    });

    it('tags a dry run with triggeredBy rule-dry-run and a null filter when none supplied', async () => {
      returningResults = [[{ id: 's-dry' }]];
      await complianceScanService.create('org-1', 'u1', 'all', undefined, true);
      const values = (tx.insert.mock.results[0].value as { values: jest.Mock }).values;
      const inserted = values.mock.calls[0][0] as Record<string, unknown>;
      expect(inserted.triggeredBy).toBe('rule-dry-run');
      expect(inserted.filter).toBeNull();
    });
  });

  describe('cancel', () => {
    it('returns the updated row when a running scan is cancelled', async () => {
      returningResults = [[{ id: 's1', status: 'cancelled' }]];
      const updated = await complianceScanService.cancel('s1', 'org-1', 'u1');
      expect(updated).toMatchObject({ status: 'cancelled' });
    });

    it('returns null when the scan is not running / not found (no-op)', async () => {
      returningResults = [[]];
      const updated = await complianceScanService.cancel('s1', 'org-1', 'u1');
      expect(updated).toBeNull();
    });
  });
});
