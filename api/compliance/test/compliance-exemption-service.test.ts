// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { jest, describe, it, expect, beforeEach } from '@jest/globals';

let selectResults: unknown[][] = [];
let returningResults: unknown[][] = [];

function shift(q: unknown[][]): unknown[] {
  return q.length ? (q.shift() as unknown[]) : [];
}

function makeChain(terminal: () => Promise<unknown[]>): Record<string, unknown> {
  const chain: Record<string, unknown> = {};
  for (const name of ['from', 'where', 'set', 'orderBy', 'limit', 'offset', 'values']) {
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
  delete: jest.fn(() => makeChain(() => Promise.resolve(shift(returningResults)))),
};

const buildComplianceExemptionConditions = jest.fn((_filter: unknown, orgId: string) => [{ orgScoped: orgId }]);

jest.unstable_mockModule('@pipeline-builder/pipeline-data', () => ({
  schema: {
    complianceExemption: {
      id: 'col_id',
      orgId: 'col_org',
      ruleId: 'col_rule',
      entityId: 'col_entity',
      status: 'col_status',
      expiresAt: 'col_exp',
      createdAt: 'col_created',
      createdBy: 'col_cby',
      updatedBy: 'col_uby',
      updatedAt: 'col_uat',
      approvedBy: 'col_aby',
      rejectionReason: 'col_rej',
      entityType: 'col_etype',
    },
  },
  withTenantTx: (cb: (t: typeof tx) => Promise<unknown>) => cb(tx),
  drizzleCount: (r: unknown) => r,
  buildComplianceExemptionConditions: (f: unknown, o: string) => buildComplianceExemptionConditions(f, o),
}));

const { complianceExemptionService, CE_NOT_FOUND, CE_SELF_APPROVE } =
  await import('../src/services/compliance-exemption-service.js');

describe('ComplianceExemptionService', () => {
  beforeEach(() => {
    selectResults = [];
    returningResults = [];
    tx.select.mockClear();
    tx.insert.mockClear();
    tx.update.mockClear();
    tx.delete.mockClear();
    buildComplianceExemptionConditions.mockClear();
  });

  describe('getActiveExemptionsForEntity', () => {
    it('maps approved, non-expired rows to {id, ruleId}', async () => {
      selectResults = [[{ id: 'ex-1', ruleId: 'r1' }, { id: 'ex-2', ruleId: 'r2' }]];
      const active = await complianceExemptionService.getActiveExemptionsForEntity('org-1', 'entity-1');
      expect(active).toEqual([{ id: 'ex-1', ruleId: 'r1' }, { id: 'ex-2', ruleId: 'r2' }]);
    });
  });

  describe('getActiveExemptionsForEntities', () => {
    it('short-circuits (no query) for an empty entity list', async () => {
      const map = await complianceExemptionService.getActiveExemptionsForEntities('org-1', []);
      expect(map.size).toBe(0);
      expect(tx.select).not.toHaveBeenCalled();
    });

    it('buckets rows by entityId', async () => {
      selectResults = [[
        { id: 'ex-1', ruleId: 'r1', entityId: 'a' },
        { id: 'ex-2', ruleId: 'r2', entityId: 'a' },
        { id: 'ex-3', ruleId: 'r3', entityId: 'b' },
      ]];
      const map = await complianceExemptionService.getActiveExemptionsForEntities('org-1', ['a', 'b']);
      expect(map.get('a')).toEqual([{ id: 'ex-1', ruleId: 'r1' }, { id: 'ex-2', ruleId: 'r2' }]);
      expect(map.get('b')).toEqual([{ id: 'ex-3', ruleId: 'r3' }]);
    });
  });

  describe('list', () => {
    it('threads the caller orgId into the condition builder (tenancy)', async () => {
      selectResults = [[{ count: 1 }], [{ id: 'ex-1' }]];
      const result = await complianceExemptionService.list({ status: 'approved' }, 'org-1', 20, 0);
      expect(buildComplianceExemptionConditions).toHaveBeenCalledWith({ status: 'approved' }, 'org-1');
      expect(result.total).toBe(1);
      expect(result.exemptions).toHaveLength(1);
    });
  });

  describe('review (approval authorization)', () => {
    it('approves when the reviewer is not the requester', async () => {
      selectResults = [[{ createdBy: 'requester' }]];
      returningResults = [[{ id: 'ex-1', status: 'approved', approvedBy: 'approver' }]];
      const updated = await complianceExemptionService.review('ex-1', 'org-1', 'approver', 'approved');
      expect(updated).toMatchObject({ status: 'approved', approvedBy: 'approver' });
    });

    it('refuses self-approval (requester cannot approve their own exemption)', async () => {
      selectResults = [[{ createdBy: 'u1' }]];
      await expect(
        complianceExemptionService.review('ex-1', 'org-1', 'u1', 'approved'),
      ).rejects.toThrow(CE_SELF_APPROVE);
      // Guard fires BEFORE any write.
      expect(tx.update).not.toHaveBeenCalled();
    });

    it('allows the requester to REJECT their own exemption (self-approval guard is approve-only)', async () => {
      selectResults = [[{ createdBy: 'u1' }]];
      returningResults = [[{ id: 'ex-1', status: 'rejected' }]];
      const updated = await complianceExemptionService.review('ex-1', 'org-1', 'u1', 'rejected', 'not needed');
      expect(updated).toMatchObject({ status: 'rejected' });
    });

    it('throws CE_NOT_FOUND when there is no pending exemption for the id+org', async () => {
      selectResults = [[]];
      await expect(
        complianceExemptionService.review('ex-1', 'other-org', 'approver', 'approved'),
      ).rejects.toThrow(CE_NOT_FOUND);
    });

    it('throws CE_NOT_FOUND when the update matches nothing (lost race)', async () => {
      selectResults = [[{ createdBy: 'requester' }]];
      returningResults = [[]];
      await expect(
        complianceExemptionService.review('ex-1', 'org-1', 'approver', 'approved'),
      ).rejects.toThrow(CE_NOT_FOUND);
    });
  });

  describe('delete', () => {
    it('returns the deleted row', async () => {
      returningResults = [[{ id: 'ex-1' }]];
      const deleted = await complianceExemptionService.delete('ex-1', 'org-1');
      expect(deleted).toMatchObject({ id: 'ex-1' });
    });

    it('returns null when nothing was deleted (cross-tenant / missing)', async () => {
      returningResults = [[]];
      const deleted = await complianceExemptionService.delete('ex-1', 'other-org');
      expect(deleted).toBeNull();
    });
  });
});
