// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

const cacheGetOrSet = jest.fn((_key: string, factory: () => Promise<unknown>) => factory());
const cacheInvalidatePattern = jest.fn().mockResolvedValue(0);

class StubCrudService {
  find = jest.fn();
  findById = jest.fn();
  create = jest.fn();
  update = jest.fn();
  delete = jest.fn();
}

const dbInsertValues = jest.fn().mockResolvedValue(undefined);
const dbInsert = jest.fn(() => ({ values: dbInsertValues }));

// Helper builder for chainable db.select(...).from(...).innerJoin(...).where(...) etc.
let selectResult: unknown[] = [];
function makeSelectChain(): Record<string, unknown> {
  const chain: Record<string, unknown> = {};
  const result = (): Promise<unknown[]> => Promise.resolve(selectResult);
  // Make each chainable method return the chain itself; terminal awaits resolve to selectResult.
  for (const name of ['from', 'innerJoin', 'leftJoin', 'where', 'orderBy', 'limit', 'offset']) {
    chain[name] = jest.fn(() => chain);
  }
  // Make the chain awaitable
  (chain as { then: unknown }).then = (resolve: (v: unknown[]) => unknown) => result().then(resolve);
  return chain;
}
const dbSelect = jest.fn(() => makeSelectChain());

jest.mock('@pipeline-builder/api-core', () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }),
  errorMessage: (err: unknown) => (err instanceof Error ? err.message : String(err)),
  createCacheService: () => ({
    getOrSet: (...args: unknown[]) => cacheGetOrSet(...args as [string, () => Promise<unknown>]),
    invalidatePattern: cacheInvalidatePattern,
  }),
}));

jest.mock('@pipeline-builder/pipeline-core', () => ({
  CrudService: StubCrudService,
  CoreConstants: { CACHE_TTL_COMPLIANCE_RULES: 60 },
  buildComplianceRuleConditions: jest.fn(() => []),
  drizzleCount: (r: unknown) => r,
  schema: {
    complianceRule: {
      id: 'col_id', orgId: 'col_orgId', name: 'col_name',
      target: 'col_target', isActive: 'col_isActive', scope: 'col_scope',
      priority: 'col_priority', severity: 'col_severity',
      createdAt: 'col_createdAt', updatedAt: 'col_updatedAt',
    },
    complianceRuleSubscription: {
      id: 'col_sid', orgId: 'col_sorg', ruleId: 'col_sruleId', isActive: 'col_sactive',
    },
    complianceRuleHistory: {
      ruleId: 'col_hr', orgId: 'col_horg', changedAt: 'col_hat',
    },
    complianceScan: {},
  },
  db: {
    insert: dbInsert,
    select: dbSelect,
  },
}));

jest.mock('../src/helpers/rule-change-notifier', () => ({
  notifyPublishedRuleChange: jest.fn().mockResolvedValue(undefined),
}));

import { ComplianceRuleService } from '../src/services/compliance-rule-service';

describe('ComplianceRuleService', () => {
  let svc: ComplianceRuleService;

  beforeEach(() => {
    selectResult = [];
    dbInsert.mockClear();
    dbInsertValues.mockClear();
    dbSelect.mockClear();
    cacheGetOrSet.mockClear();
    cacheInvalidatePattern.mockClear();
    svc = new ComplianceRuleService();
  });

  describe('findActiveByOrgAndTarget', () => {
    it('returns the org rules when there are no published-rule subscriptions', async () => {
      jest.spyOn(svc, 'find').mockResolvedValue([{ id: 'r1' }, { id: 'r2' }] as never);
      selectResult = []; // no subscribed published rules

      const rules = await svc.findActiveByOrgAndTarget('org-1', 'plugin');

      expect(svc.find).toHaveBeenCalledWith({ target: 'plugin', isActive: true }, 'org-1');
      expect(rules).toHaveLength(2);
      expect(cacheGetOrSet).toHaveBeenCalled();
    });

    it('merges subscribed published rules and dedupes by id', async () => {
      jest.spyOn(svc, 'find').mockResolvedValue([{ id: 'r1' }, { id: 'r2' }] as never);
      selectResult = [{ rule: { id: 'r2' } }, { rule: { id: 'r3' } }];

      const rules = await svc.findActiveByOrgAndTarget('org-1', 'pipeline');

      const ids = rules.map(r => r.id).sort();
      expect(ids).toEqual(['r1', 'r2', 'r3']);
    });
  });

  describe('invalidateRulesCache', () => {
    it('invalidates by orgId pattern', async () => {
      await svc.invalidateRulesCache('org-7');
      expect(cacheInvalidatePattern).toHaveBeenCalledWith('org-7:*');
    });
  });

  describe('forkRule', () => {
    it('throws when source rule is missing', async () => {
      selectResult = [];
      await expect(svc.forkRule('rule-x', 'org-1', 'user-1')).rejects.toThrow('Published rule not found');
    });

    it('creates a forked rule with scope=org and source ref', async () => {
      const source = {
        id: 'src',
        name: 'security-scan',
        description: 'd',
        priority: 50,
        target: 'plugin',
        severity: 'error',
        tags: ['t'],
        suppressNotification: false,
        field: 'f',
        operator: 'eq',
        value: 'v',
        conditions: null,
        conditionMode: null,
      };
      selectResult = [source];
      const createSpy = jest.spyOn(svc, 'create').mockImplementation(async (data: any) => ({ ...(data as Record<string, unknown>), id: 'new' } as never));

      const result = await svc.forkRule('src', 'org-1', 'user-1');

      expect(createSpy).toHaveBeenCalledWith(expect.objectContaining({
        orgId: 'org-1',
        name: 'security-scan-custom',
        scope: 'org',
        forkedFromRuleId: 'src',
        createdBy: 'user-1',
      }), 'user-1');
      expect((result as { id: string }).id).toBe('new');
    });
  });

  describe('findAllEnforced', () => {
    it('returns rules across both targets when target unspecified', async () => {
      jest.spyOn(svc, 'findActiveByOrgAndTarget')
        .mockResolvedValueOnce([{ id: 'p1' }] as never)
        .mockResolvedValueOnce([{ id: 'pl1' }] as never);

      const result = await svc.findAllEnforced('org-1');

      expect(svc.findActiveByOrgAndTarget).toHaveBeenCalledTimes(2);
      expect(result).toHaveLength(2);
    });

    it('returns rules for a single target when specified', async () => {
      jest.spyOn(svc, 'findActiveByOrgAndTarget').mockResolvedValue([{ id: 'p1' }] as never);

      const result = await svc.findAllEnforced('org-1', 'plugin');

      expect(svc.findActiveByOrgAndTarget).toHaveBeenCalledTimes(1);
      expect(svc.findActiveByOrgAndTarget).toHaveBeenCalledWith('org-1', 'plugin');
      expect(result).toHaveLength(1);
    });
  });

  describe('findByPolicy', () => {
    it('calls find with policyId + isActive filter', async () => {
      const findSpy = jest.spyOn(svc, 'find').mockResolvedValue([{ id: 'r1' }] as never);

      const result = await svc.findByPolicy('policy-1', 'org-1');

      expect(findSpy).toHaveBeenCalledWith({ policyId: 'policy-1', isActive: true }, 'org-1');
      expect(result).toHaveLength(1);
    });
  });

  describe('recordHistory', () => {
    it('inserts a history row with the change details', async () => {
      await svc.recordHistory('rule-1', 'org-1', 'updated', { name: 'old' }, 'user-1');
      expect(dbInsert).toHaveBeenCalled();
      expect(dbInsertValues).toHaveBeenCalledWith(expect.objectContaining({
        ruleId: 'rule-1',
        orgId: 'org-1',
        changeType: 'updated',
        changedBy: 'user-1',
        previousState: { name: 'old' },
      }));
    });
  });
});
