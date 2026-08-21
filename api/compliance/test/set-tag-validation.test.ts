// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * #7 — a PUBLISHED rule created/updated with a `set:<x>` tag whose `<x>` is not a
 * KNOWN content set is rejected (`InvalidSetTagError` → 400 at the route). This
 * prevents a typo'd `set:advance` from being invisible to the entitlement gate
 * (enforced free-to-all AND absent from any paid library). Org-scoped rules are
 * unaffected — a stray `set:` tag on them is inert.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

let existingRule: Record<string, unknown> | undefined;

// Base-class methods MUST live on the prototype (not instance fields) or they
// would SHADOW the ComplianceRuleService override under test — the subclass's
// `create`/`update` (where the set-tag guard lives) would never run.
class StubCrudService {
  find(): unknown { return undefined; }
  async findById(): Promise<unknown> { return existingRule; }
  async create(data: Record<string, unknown>): Promise<unknown> { return { ...data, id: 'new-id' }; }
  async update(id: string, data: Record<string, unknown>): Promise<unknown> {
    return { ...data, id, name: data.name ?? 'r', target: 'plugin', scope: existingRule?.scope };
  }
  delete(): unknown { return undefined; }
}

const dbInsertValues = jest.fn().mockResolvedValue(undefined);
const dbInsert = jest.fn(() => ({ values: dbInsertValues }));
function makeSelectChain(): Record<string, unknown> {
  const chain: Record<string, unknown> = {};
  for (const name of ['from', 'innerJoin', 'leftJoin', 'where', 'orderBy', 'limit', 'offset']) chain[name] = jest.fn(() => chain);
  (chain as { then: unknown }).then = (resolve: (v: unknown[]) => unknown) => Promise.resolve([]).then(resolve);
  return chain;
}
const dbSelect = jest.fn(() => makeSelectChain());

const pipelineDataMock = {
  CrudService: StubCrudService,
  CoreConstants: { CACHE_TTL_COMPLIANCE_RULES: 60 },
  buildComplianceRuleConditions: jest.fn(() => []),
  buildPublishedRuleCatalogConditions: jest.fn(() => []),
  drizzleCount: (r: unknown) => r,
  schema: {
    complianceRule: { id: 'id', orgId: 'orgId', name: 'name', target: 'target', isActive: 'isActive', scope: 'scope' },
    complianceRuleSubscription: { id: 'sid', orgId: 'sorg', ruleId: 'sruleId', isActive: 'sactive' },
    complianceRuleHistory: { ruleId: 'hr', orgId: 'horg', changedAt: 'hat' },
    complianceScan: {},
  },
  runWithTenantContext: (_ctx: unknown, fn: () => unknown) => fn(),
  withTenantTx: (fn: (tx: unknown) => unknown) => fn({ insert: dbInsert, select: dbSelect }),
};

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock());
jest.unstable_mockModule('@pipeline-builder/pipeline-core', () => pipelineDataMock);
jest.unstable_mockModule('@pipeline-builder/pipeline-data', () => pipelineDataMock);
jest.unstable_mockModule('../src/engine/rule-operators.js', () => ({ validateRuleRegexPatterns: () => null }));
jest.unstable_mockModule('../src/helpers/rule-change-notifier.js', () => ({
  notifyPublishedRuleChange: jest.fn<(...a: unknown[]) => Promise<unknown>>().mockResolvedValue(undefined),
}));

const { ComplianceRuleService, InvalidSetTagError } = await import('../src/services/compliance-rule-service.js');

describe('#7 set-tag validation on published rules', () => {
  let svc: InstanceType<typeof ComplianceRuleService>;
  beforeEach(() => {
    jest.clearAllMocks();
    existingRule = undefined;
    svc = new ComplianceRuleService();
  });

  describe('create', () => {
    it('accepts a published rule tagged with a KNOWN set', async () => {
      const rule = await svc.create({ scope: 'published', tags: ['set:advanced'], target: 'plugin', name: 'r', orgId: 'sys' } as never, 'u1');
      expect(rule).toBeDefined();
    });

    it('rejects a published rule tagged with an UNKNOWN set (typo)', async () => {
      await expect(
        svc.create({ scope: 'published', tags: ['set:advance'], target: 'plugin', name: 'r', orgId: 'sys' } as never, 'u1'),
      ).rejects.toBeInstanceOf(InvalidSetTagError);
    });

    it('leaves org-scoped rules unvalidated (a stray set tag is inert)', async () => {
      const rule = await svc.create({ scope: 'org', tags: ['set:advance'], target: 'plugin', name: 'r', orgId: 'org-a' } as never, 'u1');
      expect(rule).toBeDefined();
    });
  });

  describe('update', () => {
    it('rejects an unknown set tag when the target rule is published', async () => {
      existingRule = { id: 'r1', scope: 'published', target: 'plugin', name: 'r', orgId: 'sys' };
      await expect(
        svc.update('r1', { tags: ['set:bogus'] } as never, 'sys', 'u1'),
      ).rejects.toBeInstanceOf(InvalidSetTagError);
    });

    it('accepts a known set tag on a published rule', async () => {
      existingRule = { id: 'r1', scope: 'published', target: 'plugin', name: 'r', orgId: 'sys' };
      const updated = await svc.update('r1', { tags: ['set:standard'] } as never, 'sys', 'u1');
      expect(updated).toBeDefined();
    });

    it('does not validate an org-scoped rule', async () => {
      existingRule = { id: 'r1', scope: 'org', target: 'plugin', name: 'r', orgId: 'org-a' };
      const updated = await svc.update('r1', { tags: ['set:bogus'] } as never, 'org-a', 'u1');
      expect(updated).toBeDefined();
    });

    it('skips validation when the update carries no tags', async () => {
      existingRule = { id: 'r1', scope: 'published', target: 'plugin', name: 'r', orgId: 'sys' };
      const updated = await svc.update('r1', { name: 'renamed' } as never, 'sys', 'u1');
      expect(updated).toBeDefined();
    });
  });
});
