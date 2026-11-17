// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Compliance rule history is the audit trail of rule changes, so it commits
 * ATOMICALLY with the change:
 *  - create/update/delete write the history row in the mutation's own
 *    transaction (CrudService's onCreateInTx / onUpdateInTx / onDeleteInTx),
 *    with the pre-mutation row as `previousState`; a failed history insert
 *    fails — and rolls back — the mutation;
 *  - restore writes its row INSIDE the restore transaction (restoreExtraSet),
 *    locking the tombstone first, so a restore that does not happen leaves no
 *    "restored" entry.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import type { AnyFn } from '@pipeline-builder/api-core/testing';
import { apiCoreMock } from './helpers/mock-api-core.js';

const RULE = { id: 'rule-1', orgId: 'org-1', name: 'r', target: 'plugin', scope: 'org' };

// Prototype methods (not class fields) so the subclass overrides run and
// `super.x()` resolves here — see rule-delete-notify.test.ts.
// The stub mutations run the in-tx hooks the way CrudService does: inside the
// (mock) transaction, after the write, a throw propagating to the caller.
const superUpdate = jest.fn<AnyFn>();
type HookFn = (e: unknown, tx: unknown, ctx: unknown) => Promise<void>;
class StubCrudService {
  async find(): Promise<unknown> { return []; }
  async findById(): Promise<unknown> { return { ...RULE, value: 'before' }; }
  async create(_d: unknown, userId: string): Promise<unknown> {
    await (this as unknown as { onCreateInTx: HookFn }).onCreateInTx(RULE, { insert: dbInsert }, { userId, operation: 'create' });
    return RULE;
  }
  async update(...args: unknown[]): Promise<unknown> {
    superUpdate(...args);
    await (this as unknown as { onUpdateInTx: HookFn }).onUpdateInTx(RULE, { insert: dbInsert }, { userId: args[3], orgId: args[2], operation: 'update' });
    return RULE;
  }
  async delete(_id: string, orgId: string, userId: string): Promise<unknown> {
    await (this as unknown as { onDeleteInTx: HookFn }).onDeleteInTx(RULE, { insert: dbInsert }, { userId, orgId, operation: 'delete' });
    return RULE;
  }
}

const order: string[] = [];
const dbInsertValues = jest.fn<AnyFn>(async () => { order.push('history'); });
const dbInsert = jest.fn(() => ({ values: dbInsertValues }));
function makeSelectChain(): Record<string, unknown> {
  const chain: Record<string, unknown> = {};
  for (const name of ['from', 'innerJoin', 'leftJoin', 'where', 'orderBy', 'limit', 'offset']) chain[name] = jest.fn(() => chain);
  (chain as { then: unknown }).then = (resolve: (v: unknown[]) => unknown) => Promise.resolve([]).then(resolve);
  return chain;
}
const dbSelect = jest.fn(() => makeSelectChain());

const pipelineDataMock = {
  drizzleRows: <T>(rows: T[]) => rows,
  CrudService: StubCrudService,
  CoreConstants: { CACHE_TTL_COMPLIANCE_RULES_SECONDS: 60 },
  buildComplianceRuleConditions: jest.fn(() => []),
  buildPublishedRuleCatalogConditions: jest.fn(() => []),
  drizzleCount: (r: unknown) => r,
  schema: {
    complianceRule: { id: 'c_id', orgId: 'c_org', name: 'c_name', target: 'c_target', deletedAt: 'c_del', isActive: 'c_active' },
    complianceRuleSubscription: { id: 's_id', orgId: 's_org', ruleId: 's_rid', unsubscribedAt: 's_unsub', isActive: 's_active' },
    complianceRuleHistory: { ruleId: 'h_rid', orgId: 'h_org', changedAt: 'h_at' },
    complianceScan: { id: 'sc_id', orgId: 'sc_org', target: 'sc_target', status: 'sc_status' },
  },
  runWithTenantContext: (_ctx: unknown, fn: () => unknown) => fn(),
  withTenantTx: (fn: (tx: unknown) => unknown) => fn({ insert: dbInsert, select: dbSelect }),
};

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock());
jest.unstable_mockModule('@pipeline-builder/pipeline-core', () => pipelineDataMock);
jest.unstable_mockModule('@pipeline-builder/pipeline-data', () => pipelineDataMock);
jest.unstable_mockModule('../src/helpers/rule-change-notifier.js', () => ({
  notifyPublishedRuleChange: jest.fn(async () => undefined),
}));

const { ComplianceRuleService } = await import('../src/services/compliance-rule-service.js');

let svc: InstanceType<typeof ComplianceRuleService>;
const historyRows = () => dbInsertValues.mock.calls.map(([v]) => v as Record<string, unknown>).filter((v) => 'changeType' in v);

beforeEach(() => {
  jest.clearAllMocks();
  order.length = 0;
  dbInsertValues.mockImplementation(async () => { order.push('history'); });
  svc = new ComplianceRuleService();
});

describe('create / update / delete write history in the mutation transaction', () => {
  it.each([
    ['create', 'created', null, () => svc.create({ name: 'r', target: 'plugin', orgId: 'org-1' } as never, 'u-1')],
    ['update', 'updated', { ...RULE, value: 'before' }, () => svc.update('rule-1', { description: 'x' } as never, 'org-1', 'u-1')],
    ['delete', 'deleted', { ...RULE, value: 'before' }, () => svc.delete('rule-1', 'org-1', 'u-1')],
  ])('%s writes the history row (prior state %#) inside the transaction', async (_op, changeType, previousState, run) => {
    await run();
    expect(historyRows()).toEqual([expect.objectContaining({ ruleId: 'rule-1', orgId: 'org-1', changeType, changedBy: 'u-1', previousState })]);
  });

  it('a failed history insert fails the mutation (it rolls back with it) — no retry, no lost row', async () => {
    dbInsertValues.mockImplementation(async (v: unknown) => {
      if ((v as Record<string, unknown>).changeType) throw new Error('pg down');
    });
    await expect(svc.delete('rule-1', 'org-1', 'u-1')).rejects.toThrow('pg down');
    expect(historyRows()).toHaveLength(1);
  });

  it('passes expectedUpdatedAt through to CrudService.update', async () => {
    await svc.update('rule-1', { description: 'x' } as never, 'org-1', 'u-1', { expectedUpdatedAt: '2026-01-01T00:00:00.000Z' });
    expect(superUpdate).toHaveBeenCalledWith('rule-1', { description: 'x' }, 'org-1', 'u-1', { expectedUpdatedAt: '2026-01-01T00:00:00.000Z' });
  });

  it('concurrent mutations each record their OWN prior state', async () => {
    const seen = jest.spyOn(StubCrudService.prototype, 'findById');
    seen.mockImplementationOnce(async () => ({ ...RULE, value: 'a' })).mockImplementationOnce(async () => ({ ...RULE, value: 'b' }));
    await Promise.all([
      svc.update('rule-1', { description: 'x' } as never, 'org-1', 'u-1'),
      svc.update('rule-1', { description: 'y' } as never, 'org-1', 'u-1'),
    ]);
    expect(historyRows().map((r) => (r.previousState as { value: string }).value).sort()).toEqual(['a', 'b']);
    seen.mockRestore();
  });
});

describe('restore writes history in the restore transaction', () => {
  type Restorable = { restoreExtraSet(id: string, tx: unknown, orgId?: string, userId?: string): Promise<Record<string, unknown>> };
  function txWith(tombstone: unknown[]) {
    const forUpdate = jest.fn(async (_mode: string) => tombstone);
    const where = jest.fn(() => ({ for: forUpdate }));
    const tx = { select: jest.fn(() => ({ from: () => ({ where }) })), insert: dbInsert };
    return { tx, forUpdate };
  }

  it('locks the tombstone FOR UPDATE and inserts the restored row in the same tx', async () => {
    const { tx, forUpdate } = txWith([{ id: 'rule-1', orgId: 'org-1' }]);
    await expect((svc as unknown as Restorable).restoreExtraSet('rule-1', tx, 'org-1', 'u-1')).resolves.toEqual({});
    expect(forUpdate).toHaveBeenCalledWith('update');
    expect(historyRows()).toEqual([expect.objectContaining({ ruleId: 'rule-1', orgId: 'org-1', changeType: 'restored', changedBy: 'u-1' })]);
  });

  it('writes nothing when the row is no longer a tombstone (the restore will match nothing)', async () => {
    const { tx } = txWith([]);
    await (svc as unknown as Restorable).restoreExtraSet('rule-1', tx, 'org-1', 'u-1');
    expect(historyRows()).toHaveLength(0);
  });

  it('onAfterRestore no longer writes a second, out-of-tx history row', async () => {
    await (svc as unknown as { onAfterRestore(id: string, e: unknown, u: string): Promise<void> }).onAfterRestore('rule-1', RULE, 'u-1');
    expect(historyRows()).toHaveLength(0);
  });
});
