// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

// Result the next select(...).where(...) chain should resolve to.
let nextSelectResult: unknown[] = [];
// Track the result returned from update(...).returning() and insert(...).returning()
let nextReturningResult: unknown[] = [];

function makeChain(terminal: () => Promise<unknown[]>): Record<string, unknown> {
  const chain: Record<string, unknown> = {};
  for (const name of ['from', 'innerJoin', 'leftJoin', 'where', 'set', 'orderBy', 'limit', 'offset', 'values', 'onConflictDoUpdate', 'onConflictDoNothing']) {
    chain[name] = jest.fn(() => chain);
  }
  chain.returning = jest.fn(() => Promise.resolve(nextReturningResult));
  (chain as { then: unknown }).then = (resolve: (v: unknown[]) => unknown) => terminal().then(resolve);
  return chain;
}

const tx = {
  select: jest.fn(() => makeChain(() => Promise.resolve(nextSelectResult))),
  insert: jest.fn(() => makeChain(() => Promise.resolve(nextReturningResult))),
  update: jest.fn(() => makeChain(() => Promise.resolve(nextReturningResult))),
};

const dbSelect = jest.fn(() => makeChain(() => Promise.resolve(nextSelectResult)));
const dbInsert = jest.fn(() => makeChain(() => Promise.resolve(nextReturningResult)));
const dbUpdate = jest.fn(() => makeChain(() => Promise.resolve(nextReturningResult)));
const dbTransaction = jest.fn((cb: (t: typeof tx) => Promise<unknown>) => cb(tx));

jest.mock('@pipeline-builder/api-core', () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }),
  SYSTEM_ORG_ID: 'system',
}));

jest.mock('@pipeline-builder/pipeline-core', () => ({
  schema: {
    complianceRule: {
      id: 'col_id', scope: 'col_scope', deletedAt: 'col_del', isActive: 'col_active',
    },
    complianceRuleSubscription: {
      id: 'col_sid', orgId: 'col_org', ruleId: 'col_rid',
      isActive: 'col_active', subscribedBy: 'col_subby', subscribedAt: 'col_subat',
      unsubscribedAt: 'col_unsubat', unsubscribedBy: 'col_unsubby', pinnedVersion: 'col_pinned',
    },
  },
  db: {
    select: (...args: unknown[]) => dbSelect(...args),
    insert: (...args: unknown[]) => dbInsert(...args),
    update: (...args: unknown[]) => dbUpdate(...args),
    transaction: (cb: (t: typeof tx) => Promise<unknown>) => dbTransaction(cb),
  },
}));

import { ComplianceRuleSubscriptionService } from '../src/services/subscription-service';

describe('ComplianceRuleSubscriptionService', () => {
  let svc: ComplianceRuleSubscriptionService;

  beforeEach(() => {
    nextSelectResult = [];
    nextReturningResult = [];
    tx.select.mockClear();
    tx.insert.mockClear();
    tx.update.mockClear();
    dbSelect.mockClear();
    dbInsert.mockClear();
    dbUpdate.mockClear();
    dbTransaction.mockClear();
    svc = new ComplianceRuleSubscriptionService();
  });

  describe('subscribe', () => {
    it('rejects system org', async () => {
      await expect(svc.subscribe('system', 'rule-1', 'u1')).rejects.toThrow(/System org/);
    });

    it('rejects when rule not found', async () => {
      nextSelectResult = [];
      await expect(svc.subscribe('org-1', 'rule-1', 'u1')).rejects.toThrow('Rule not found');
    });

    it('rejects when rule is not published', async () => {
      nextSelectResult = [{ id: 'rule-1', scope: 'org' }];
      await expect(svc.subscribe('org-1', 'rule-1', 'u1')).rejects.toThrow(/published/);
    });

    it('inserts subscription as inactive when rule is published', async () => {
      nextSelectResult = [{ id: 'rule-1', scope: 'published' }];
      nextReturningResult = [{ id: 'sub-1', orgId: 'org-1', ruleId: 'rule-1', isActive: false }];

      const result = await svc.subscribe('org-1', 'rule-1', 'u1');
      expect(tx.insert).toHaveBeenCalled();
      expect((result as { id: string }).id).toBe('sub-1');
    });
  });

  describe('setActive', () => {
    it('rejects system org', async () => {
      await expect(svc.setActive('SYSTEM', 'r', true, 'u')).rejects.toThrow(/System org/);
    });

    it('rejects when subscription not found', async () => {
      nextSelectResult = [];
      await expect(svc.setActive('org-1', 'r', true, 'u')).rejects.toThrow('Subscription not found');
    });

    it('updates active flag when subscription exists', async () => {
      nextSelectResult = [{ id: 'sub-1' }];
      nextReturningResult = [{ id: 'sub-1', isActive: true }];

      const result = await svc.setActive('org-1', 'r', true, 'u');
      expect(tx.update).toHaveBeenCalled();
      expect((result as { isActive: boolean }).isActive).toBe(true);
    });
  });

  describe('unsubscribe', () => {
    it('rejects system org', async () => {
      await expect(svc.unsubscribe('system', 'r', 'u')).rejects.toThrow(/System org/);
    });

    it('rejects when subscription not found', async () => {
      nextSelectResult = [];
      await expect(svc.unsubscribe('org-1', 'r', 'u')).rejects.toThrow('Subscription not found');
    });

    it('soft-deletes subscription when found', async () => {
      nextSelectResult = [{ id: 'sub-1' }];
      await svc.unsubscribe('org-1', 'r', 'u');
      expect(tx.update).toHaveBeenCalled();
    });
  });

  describe('autoSubscribeToPublished', () => {
    it('returns 0 for system org', async () => {
      const count = await svc.autoSubscribeToPublished('SYSTEM');
      expect(count).toBe(0);
      expect(dbSelect).not.toHaveBeenCalled();
    });

    it('returns 0 when no published rules exist', async () => {
      nextSelectResult = [];
      const count = await svc.autoSubscribeToPublished('org-1');
      expect(count).toBe(0);
      expect(dbInsert).not.toHaveBeenCalled();
    });

    it('inserts batch and returns count of new subscriptions', async () => {
      nextSelectResult = [{ id: 'r1' }, { id: 'r2' }];
      nextReturningResult = [{ id: 'sub-1' }, { id: 'sub-2' }];

      const count = await svc.autoSubscribeToPublished('org-1');
      expect(dbInsert).toHaveBeenCalled();
      expect(count).toBe(2);
    });
  });

  describe('bulkSetActive', () => {
    it('rejects system org', async () => {
      await expect(svc.bulkSetActive('system', ['r1'], true, 'u')).rejects.toThrow(/System org/);
    });

    it('returns count of updated rows', async () => {
      nextReturningResult = [{ id: 'a' }, { id: 'b' }];
      const count = await svc.bulkSetActive('org-1', ['r1', 'r2'], false, 'u');
      expect(dbUpdate).toHaveBeenCalled();
      expect(count).toBe(2);
    });
  });

  describe('pinVersion', () => {
    it('rejects system org', async () => {
      await expect(svc.pinVersion('system', 'r', 'u')).rejects.toThrow(/System org/);
    });

    it('throws when subscription is missing', async () => {
      nextSelectResult = [];
      await expect(svc.pinVersion('org-1', 'r', 'u')).rejects.toThrow('Subscription not found');
    });
  });

  describe('unpinVersion', () => {
    it('throws when subscription not found', async () => {
      nextReturningResult = [];
      await expect(svc.unpinVersion('org-1', 'r')).rejects.toThrow('Subscription not found');
    });

    it('returns updated subscription', async () => {
      nextReturningResult = [{ id: 'sub-1', pinnedVersion: null }];
      const result = await svc.unpinVersion('org-1', 'r');
      expect((result as { id: string }).id).toBe('sub-1');
    });
  });

  describe('getSubscribedRuleIds', () => {
    it('returns ruleIds from active subscriptions', async () => {
      nextSelectResult = [{ ruleId: 'r1' }, { ruleId: 'r2' }];
      const ids = await svc.getSubscribedRuleIds('org-1');
      expect(ids).toEqual(['r1', 'r2']);
    });

    it('returns empty when no active subscriptions', async () => {
      nextSelectResult = [];
      const ids = await svc.getSubscribedRuleIds('org-1');
      expect(ids).toEqual([]);
    });
  });
});
