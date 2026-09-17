// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { jest, describe, it, expect, beforeEach } from '@jest/globals';

// Stub the base CrudService so we can test only the subclass-specific methods.
class StubCrudService {
  protected enforceOrgId<T>(data: T): T { return data; }
}

// Every statement records which transaction it ran on, so a test can prove the
// policy insert and the rule-link update share ONE transaction.
let txLog: string[] = [];
let updateSets: Record<string, unknown>[] = [];
let txCounter = 0;
/** What the policy INSERT returns: the row, or [] when ON CONFLICT DO NOTHING hit an existing one. */
let insertReturnsRow = true;
const withTenantTxMock = jest.fn(async (fn: (tx: unknown) => unknown) => {
  const txId = `tx#${++txCounter}`;
  const tx = {
    insert: () => {
      txLog.push(`insert:${txId}`);
      let row: Record<string, unknown> = {};
      const chain: Record<string, unknown> = {
        values: (v: Record<string, unknown>) => { row = v; return chain; },
        onConflictDoNothing: () => chain,
        returning: async () => (insertReturnsRow ? [{ ...row, id: 'pol-1' }] : []),
      };
      return chain;
    },
    update: () => {
      txLog.push(`update:${txId}`);
      return {
        set: (v: Record<string, unknown>) => { updateSets.push(v); return { where: async () => undefined }; },
      };
    },
  };
  return fn(tx);
});

jest.unstable_mockModule('@pipeline-builder/pipeline-data', () => ({
  CrudService: StubCrudService,
  buildCompliancePolicyConditions: jest.fn(() => []),
  withTenantTx: (fn: (tx: unknown) => unknown) => withTenantTxMock(fn),
  schema: {
    compliancePolicy: {
      name: 'col_name',
      createdAt: 'col_createdAt',
      updatedAt: 'col_updatedAt',
      orgId: 'col_orgId',
      version: 'col_version',
    },
    complianceRule: {
      orgId: 'col_rorgId',
      name: 'col_rname',
      policyId: 'col_policyId',
    },
  },
}));

const { CompliancePolicyService } = await import('../src/services/policy-service.js');

describe('CompliancePolicyService', () => {
  let svc: InstanceType<typeof CompliancePolicyService>;

  beforeEach(() => {
    svc = new CompliancePolicyService();
    txLog = [];
    updateSets = [];
    txCounter = 0;
    insertReturnsRow = true;
    withTenantTxMock.mockClear();
  });

  describe('createWithRules', () => {
    it('inserts the policy AND links the rules on ONE transaction', async () => {
      const policyRow = { id: 'pol-1', orgId: 'org-a', name: 'Baseline', version: '1.0.0' };
      const created = await svc.createWithRules(
        { orgId: 'org-a', name: 'Baseline', version: '1.0.0' } as never,
        ['rule-a', 'rule-b'],
        'user-1',
      );

      expect((created as { id: string }).id).toBe(policyRow.id);
      // Exactly one transaction, and both statements ran on that same tx —
      // a failed rule-link rolls back the policy insert.
      expect(withTenantTxMock).toHaveBeenCalledTimes(1);
      expect(txLog).toEqual(['insert:tx#1', 'update:tx#1']);
      expect(updateSets[0]).toEqual(expect.objectContaining({ policyId: 'pol-1', updatedBy: 'user-1' }));
    });

    it('409s instead of overwriting an existing policy — and links no rules', async () => {
      insertReturnsRow = false;
      await expect(svc.createWithRules(
        { orgId: 'org-a', name: 'Baseline', version: '1.0.0' } as never,
        ['rule-a'],
        'user-1',
      )).rejects.toMatchObject({ statusCode: 409 });
      expect(txLog).toEqual(['insert:tx#1']);
    });

    it('skips the rule-link UPDATE when no rule names are given', async () => {
      await svc.createWithRules({ orgId: 'org-a', name: 'Baseline', version: '1.0.0' } as never, undefined, 'user-1');
      expect(withTenantTxMock).toHaveBeenCalledTimes(1);
      expect(txLog).toEqual(['insert:tx#1']);
    });
  });
});
