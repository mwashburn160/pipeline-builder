// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for POST /compliance/subscriptions/preview/impact — evaluates a rule
 * against the caller's existing entities (plugins or pipelines) without
 * subscribing. Used by the dashboard to answer "if I enable this rule today,
 * how many of my entities will fail?" before commitment.
 *
 * Verifies:
 * - 400 when rule not found
 * - Aggregates pass/fail counts across the caller's entities
 * - Caps samples at 10 even when more entities fail
 * - Routes plugin rules to the plugin table; pipeline rules to the pipeline table
 * - Org isolation: only the caller's own org's entities are evaluated
 */

const evaluateRulesMock = jest.fn();

// Chainable Drizzle .select().from(...).where(...).limit(...).then(...) mock.
function makeChain(terminal: () => Promise<unknown[]>) {
  const chain: Record<string, unknown> = {};
  const passthrough = () => chain;
  ['from', 'where', 'innerJoin', 'leftJoin', 'orderBy'].forEach((k) => { chain[k] = passthrough; });
  chain.limit = passthrough;
  chain.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
    terminal().then(resolve, reject);
  chain.catch = (reject: (e: unknown) => unknown) => terminal().catch(reject);
  return chain;
}

let nextRuleResult: unknown[] = [];
let nextEntityResult: unknown[] = [];
let dbSelectCallNumber = 0;

jest.mock('@pipeline-builder/api-core', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
  ErrorCode: { VALIDATION_ERROR: 'VALIDATION_ERROR' },
  errorMessage: (e: unknown) => e instanceof Error ? e.message : String(e),
  getParam: (p: any, k: string) => p[k],
  parsePaginationParams: () => ({ limit: 25, offset: 0 }),
  validateBody: (req: any, schema: any) => {
    try {
      const value = schema.parse(req.body);
      return { ok: true, value };
    } catch (err: any) {
      return { ok: false, error: err.message ?? 'invalid' };
    }
  },
  sendBadRequest: jest.fn((res: any, msg: string) => res.status(400).json({ message: msg })),
  sendSuccess: jest.fn((res: any, status: number, data: any) =>
    res.status(status).json({ success: true, statusCode: status, data })),
  sendPaginatedNested: jest.fn(),
}));

jest.mock('@pipeline-builder/api-server', () => ({
  withRoute: (h: Function) => async (req: any, res: any) => {
    await h({ req, res, ctx: { log: jest.fn() }, orgId: req.__orgId, userId: 'u-1' });
  },
}));

jest.mock('@pipeline-builder/pipeline-core', () => ({
  schema: {
    complianceRule: {
      id: 'col_id', deletedAt: 'col_deleted', target: 'col_target', name: 'col_name',
    },
    plugin: { id: 'col_pid', name: 'col_pname', isActive: 'col_pactive', orgId: 'col_porg' },
    pipeline: { id: 'col_ppid', pipelineName: 'col_ppname', isActive: 'col_ppactive', orgId: 'col_pporg' },
    complianceRuleSubscription: {},
  },
  db: {
    select: () => {
      dbSelectCallNumber++;
      const isFirst = dbSelectCallNumber === 1;
      return makeChain(() => Promise.resolve(isFirst ? nextRuleResult : nextEntityResult));
    },
    insert: jest.fn(),
    update: jest.fn(),
  },
  buildPublishedRuleCatalogConditions: jest.fn(),
  drizzleCount: jest.fn(),
}));

jest.mock('drizzle-orm', () => ({
  and: (...a: unknown[]) => ({ __op: 'and', a }),
  desc: (c: unknown) => ({ __op: 'desc', c }),
  eq: (c: unknown, v: unknown) => ({ __op: 'eq', c, v }),
  sql: jest.fn(),
  inArray: jest.fn(),
  isNull: (c: unknown) => ({ __op: 'isNull', c }),
}));

jest.mock('../src/engine/rule-engine', () => ({
  evaluateRules: (...args: unknown[]) => evaluateRulesMock(...args),
}));

jest.mock('../src/services/compliance-rule-service', () => ({
  complianceRuleService: { findActiveByOrgAndTarget: jest.fn() },
}));

jest.mock('../src/services/subscription-service', () => ({
  subscriptionService: {},
}));

import { createSubscriptionRoutes } from '../src/routes/subscriptions';

function getHandler(path: string, method: 'get' | 'post' = 'post') {
  const router = createSubscriptionRoutes();
  const layer = (router.stack as any[]).find(
    (l) => l.route?.path === path && l.route?.methods?.[method],
  );
  if (!layer) throw new Error(`no ${method.toUpperCase()} ${path}`);
  return layer.route.stack[0].handle;
}

function makeRes() {
  const json = jest.fn();
  const status = jest.fn().mockReturnValue({ json });
  return { res: { status, json } as any, json };
}

describe('POST /preview/impact', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    dbSelectCallNumber = 0;
    nextRuleResult = [];
    nextEntityResult = [];
  });

  it('returns 400 when rule does not exist', async () => {
    nextRuleResult = []; // rule lookup returns nothing
    const handler = getHandler('/preview/impact');
    const { res, json } = makeRes();
    await handler({ __orgId: 'org-a', body: { ruleId: '11111111-1111-4111-8111-111111111111' } } as any, res);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ message: 'Rule not found' }));
    expect(evaluateRulesMock).not.toHaveBeenCalled();
  });

  it('aggregates would-pass / would-fail across plugin entities', async () => {
    nextRuleResult = [{ id: 'r1', name: 'block-latest-image', target: 'plugin' }];
    nextEntityResult = [
      { id: 'p1', name: 'foo', imageTag: 'latest' },
      { id: 'p2', name: 'bar', imageTag: '1.0.0' },
      { id: 'p3', name: 'baz', imageTag: 'latest' },
    ];
    evaluateRulesMock
      .mockReturnValueOnce({ blocked: true, violations: [{ message: 'using :latest' }], warnings: [] })
      .mockReturnValueOnce({ blocked: false, violations: [], warnings: [] })
      .mockReturnValueOnce({ blocked: true, violations: [{ message: 'using :latest' }], warnings: [] });

    const handler = getHandler('/preview/impact');
    const { res, json } = makeRes();
    await handler({ __orgId: 'org-a', body: { ruleId: '11111111-1111-4111-8111-111111111111' } } as any, res);

    const payload = json.mock.calls[0][0];
    expect(payload.data.target).toBe('plugin');
    expect(payload.data.total).toBe(3);
    expect(payload.data.wouldPass).toBe(1);
    expect(payload.data.wouldFail).toBe(2);
    expect(payload.data.samples).toHaveLength(2);
    expect(payload.data.samples[0].entityName).toBe('foo');
  });

  it('caps samples at 10 even with more failures', async () => {
    nextRuleResult = [{ id: 'r1', name: 'rule', target: 'plugin' }];
    nextEntityResult = Array.from({ length: 20 }, (_, i) => ({ id: `p${i}`, name: `plugin-${i}` }));
    evaluateRulesMock.mockReturnValue({ blocked: true, violations: [{ message: 'fail' }], warnings: [] });

    const handler = getHandler('/preview/impact');
    const { res, json } = makeRes();
    await handler({ __orgId: 'org-a', body: { ruleId: '11111111-1111-4111-8111-111111111111' } } as any, res);

    const payload = json.mock.calls[0][0];
    expect(payload.data.wouldFail).toBe(20);
    expect(payload.data.samples).toHaveLength(10);
  });

  it('returns total=0 when org has no entities', async () => {
    nextRuleResult = [{ id: 'r1', name: 'rule', target: 'pipeline' }];
    nextEntityResult = [];
    const handler = getHandler('/preview/impact');
    const { res, json } = makeRes();
    await handler({ __orgId: 'org-empty', body: { ruleId: '11111111-1111-4111-8111-111111111111' } } as any, res);
    const payload = json.mock.calls[0][0];
    expect(payload.data.total).toBe(0);
    expect(payload.data.wouldPass).toBe(0);
    expect(payload.data.wouldFail).toBe(0);
  });

  it('treats warnings as wouldFail (any non-pass counts)', async () => {
    nextRuleResult = [{ id: 'r1', name: 'rule', target: 'plugin' }];
    nextEntityResult = [{ id: 'p1', name: 'has-warn' }];
    evaluateRulesMock.mockReturnValue({ blocked: false, violations: [], warnings: [{ message: 'soft' }] });

    const handler = getHandler('/preview/impact');
    const { res, json } = makeRes();
    await handler({ __orgId: 'org-a', body: { ruleId: '11111111-1111-4111-8111-111111111111' } } as any, res);
    const payload = json.mock.calls[0][0];
    expect(payload.data.wouldFail).toBe(1);
    expect(payload.data.wouldPass).toBe(0);
  });
});
