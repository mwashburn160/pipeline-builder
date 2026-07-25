// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Integration-style test for the published-rule DELETE → subscriber-notify flow.
 *
 * Regression: the service called `notifyPublishedRuleChange` AFTER `super.delete()`
 * soft-deleted the rule. `subscriptionService.findSubscribers` inner-joins the
 * rule with `isNull(deletedAt)`, so once the rule is soft-deleted it returns
 * ZERO rows and no subscriber is ever notified — while the (now-fixed) message
 * falsely claimed the subscription had been "automatically removed".
 *
 * The fix captures the subscriber list BEFORE the soft-delete and hands it to
 * the notifier. This test uses the REAL `findSubscribers` and REAL notifier
 * (only the DB + delivery channel are stubbed): the stub DB models the
 * `isNull(deletedAt)` filter by returning zero subscriber rows once the rule is
 * flagged deleted, so a post-delete lookup would notify no one. The test asserts
 * that both subscribers are still notified with an accurate message.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

// Simulates the `isNull(deletedAt)` inner-join filter in findSubscribers: once
// the rule is soft-deleted, the join yields no subscriber rows.
let ruleSoftDeleted = false;
const SUBSCRIBER_ROWS = [
  { compliance_rule_subscriptions: { orgId: 'org-1' } },
  { compliance_rule_subscriptions: { orgId: 'org-2' } },
];
function currentSelectResult(): unknown[] {
  return ruleSoftDeleted ? [] : SUBSCRIBER_ROWS;
}

// The existing published rule the delete targets.
const EXISTING_RULE = { id: 'rule-1', name: 'my-published-rule', target: 'plugin', scope: 'published' };

// NB: these MUST be prototype methods, not class fields. A `delete = jest.fn()`
// class field lands on the INSTANCE and would shadow the subclass's prototype
// `delete` override — so `svc.delete()` would call the stub instead of the real
// method under test, and `super.delete()` inside the override would recurse
// wrong. Prototype methods let the override run and `super.delete()` resolve here.
class StubCrudService {
  async find(): Promise<unknown> { return []; }
  async findById(): Promise<unknown> { return EXISTING_RULE; }
  async create(): Promise<unknown> { return EXISTING_RULE; }
  async update(): Promise<unknown> { return EXISTING_RULE; }
  // Soft-delete: flip the flag so a subsequent findSubscribers sees zero rows.
  async delete(): Promise<unknown> {
    ruleSoftDeleted = true;
    return EXISTING_RULE;
  }
}

function makeSelectChain(): Record<string, unknown> {
  const chain: Record<string, unknown> = {};
  for (const name of ['from', 'innerJoin', 'leftJoin', 'where', 'orderBy', 'limit', 'offset']) {
    chain[name] = jest.fn(() => chain);
  }
  (chain as { then: unknown }).then = (resolve: (v: unknown[]) => unknown) =>
    Promise.resolve(currentSelectResult()).then(resolve);
  return chain;
}
const dbInsertValues = jest.fn().mockResolvedValue(undefined);
const dbInsert = jest.fn(() => ({ values: dbInsertValues }));
const dbSelect = jest.fn(() => makeSelectChain());

const pipelineDataMock = {
  CrudService: StubCrudService,
  CoreConstants: { CACHE_TTL_COMPLIANCE_RULES: 60 },
  buildComplianceRuleConditions: jest.fn(() => []),
  buildPublishedRuleCatalogConditions: jest.fn(() => []),
  drizzleCount: (r: unknown) => r,
  schema: {
    complianceRule: { id: 'c_id', orgId: 'c_org', name: 'c_name', target: 'c_target', deletedAt: 'c_del' },
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

// Capture in-app deliveries (the channel the rule-change notifier uses).
const deliveries: Array<Record<string, unknown>> = [];
jest.unstable_mockModule('../src/helpers/notification-channels.js', () => ({
  inAppChannel: {
    deliver: jest.fn(async (notification: Record<string, unknown>) => {
      deliveries.push(notification);
    }),
  },
}));

const { ComplianceRuleService } = await import('../src/services/compliance-rule-service.js');

describe('published-rule delete → subscriber notification', () => {
  let svc: InstanceType<typeof ComplianceRuleService>;

  beforeEach(() => {
    ruleSoftDeleted = false;
    deliveries.length = 0;
    dbInsert.mockClear();
    dbInsertValues.mockClear();
    dbSelect.mockClear();
    svc = new ComplianceRuleService();
  });

  it('notifies every subscriber captured before the soft-delete', async () => {
    await svc.delete('rule-1', '000000000000000000000001', 'admin-1');

    // Fire-and-forget notifier — let the microtask queue drain.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    // The rule IS soft-deleted (a post-delete findSubscribers would see []),
    // yet both subscribers were still notified because the list was captured
    // before the delete.
    expect(ruleSoftDeleted).toBe(true);
    const orgs = deliveries.map((d) => d.recipientOrgId).sort();
    expect(orgs).toEqual(['org-1', 'org-2']);
  });

  it('uses an accurate deletion message (does not claim the subscription was removed)', async () => {
    await svc.delete('rule-1', '000000000000000000000001', 'admin-1');
    await new Promise((r) => setImmediate(r));

    expect(deliveries.length).toBeGreaterThan(0);
    const { subject, content } = deliveries[0] as { subject: string; content: string };
    expect(subject).toContain('removed');
    expect(content).toContain('no longer enforced');
    // The old, false claim is gone.
    expect(content).not.toContain('automatically removed');
  });
});
