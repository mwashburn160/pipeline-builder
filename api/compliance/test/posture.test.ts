// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `GET /internal/compliance/posture` — the compliance half of a stakeholder report's
 * posture panel.
 *
 * Two things are worth pinning, and neither is the arithmetic:
 *
 *  - WHAT IT WILL NOT SAY. Counts and a scan date. No rule names, no entity ids, no
 *    exemption reasons — a manager's report says "48 rules active, last scan blocked 3 of
 *    210"; whoever needs to know WHICH three opens the compliance dashboard, where the
 *    permission to see them is already enforced.
 *  - WHAT COUNTS AS ACTIVE. A rule scheduled for next quarter is not active, and counting
 *    it would tell a manager the org enforces something it does not. An exemption counts
 *    only while approved and unexpired: a pending request is not a carve-out, and an
 *    expired one stopped being one.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { stubModule, type AnyFn } from '@pipeline-builder/api-core/testing';
import { apiCoreMock } from './helpers/mock-api-core.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

const ORG = 'acme';

/** The three selects the handler runs, in order: rules, exemptions, scans. */
const results: unknown[][] = [];
let scopes: Array<{ orgId?: string; isSuperAdmin?: boolean }> = [];
const wheres: unknown[] = [];

const mockSendSuccess = jest.fn<AnyFn>();
const mockSendError = jest.fn<AnyFn>();

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  sendSuccess: (...a: unknown[]) => mockSendSuccess(...a),
  sendError: (...a: unknown[]) => mockSendError(...a),
  requireInternalService: () => (_req: any, _res: any, next: any) => next(),
}));

jest.unstable_mockModule('@pipeline-builder/api-server', () => stubModule('@pipeline-builder/api-server', {
  withRoute: (handler: any) => async (req: any, res: any) => {
    const ctx = { log: jest.fn(), identity: { orgId: ORG, userId: 'svc' }, requestId: 'req-1' };
    await handler({ req, res, ctx, orgId: req.orgId ?? ORG, userId: 'svc' });
  },
}));

/** Set to make the next statement reject, for the degradation path. */
let failNext = false;

/** A recording select chain that hands back the next queued result. */
function selectChain() {
  if (failNext) {
    const dead: any = {};
    dead.from = () => dead;
    dead.where = () => dead;
    dead.orderBy = () => dead;
    dead.limit = () => Promise.reject(new Error('statement timeout'));
    dead.then = (_r: unknown, reject: (e: unknown) => unknown) => Promise.reject(new Error('statement timeout')).catch(reject);
    return dead;
  }
  const chain: any = {};
  chain.from = () => chain;
  chain.where = (w: unknown) => { wheres.push(w); return chain; };
  chain.orderBy = () => chain;
  chain.limit = () => Promise.resolve(results.shift() ?? []);
  chain.then = (resolve: (v: unknown) => unknown) => Promise.resolve(results.shift() ?? []).then(resolve);
  return chain;
}

jest.unstable_mockModule('@pipeline-builder/pipeline-data', () => stubModule('@pipeline-builder/pipeline-data', {
  schema: {
    complianceRule: {
      orgId: 'org_id',
      deletedAt: 'deleted_at',
      tags: 'tags',
      effectiveFrom: 'effective_from',
      effectiveUntil: 'effective_until',
    },
    complianceExemption: { orgId: 'org_id', status: 'status', expiresAt: 'expires_at' },
    complianceScan: {
      orgId: 'org_id',
      status: 'status',
      completedAt: 'completed_at',
      totalEntities: 'total_entities',
      passCount: 'pass_count',
      warnCount: 'warn_count',
      blockCount: 'block_count',
    },
  },
  withTenantTx: (fn: (tx: unknown) => unknown) => fn({ select: () => selectChain() }),
  runWithTenantContext: <T>(ctx: { orgId?: string; isSuperAdmin?: boolean }, fn: () => T) => {
    scopes.push(ctx);
    return fn();
  },
}));

const { createPostureRoutes } = await import('../src/routes/posture.js');

/** Drive the mounted GET handler. */
async function call(orgId = ORG): Promise<void> {
  const router = createPostureRoutes() as any;
  const layer = router.stack.find((l: any) => l.route?.path === '/');
  const handler = layer.route.stack[layer.route.stack.length - 1].handle;
  await handler({ params: {}, query: {}, orgId, user: {} }, {});
}

const payload = () => mockSendSuccess.mock.calls[0]?.[2] as Record<string, unknown>;

const RULES = [{ tags: ['SOC 2', 'PCI DSS'] }, { tags: ['SOC 2'] }, { tags: null }];
const EXEMPTIONS = [{ n: 3 }];
const SCANS = [{
  completedAt: new Date('2026-09-20T00:00:00Z'),
  total: 210,
  pass: 205,
  warn: 2,
  block: 3,
}];

beforeEach(() => {
  jest.clearAllMocks();
  results.length = 0;
  wheres.length = 0;
  scopes = [];
  failNext = false;
});

describe('GET /internal/compliance/posture', () => {
  it('returns the counts, the frameworks and the last scan', async () => {
    results.push(RULES, EXEMPTIONS, SCANS, RULES);
    await call();
    expect(payload()).toEqual({
      activeRules: 3,
      activeExemptions: 3,
      // Deduped and sorted here rather than left to row order, because the report shows
      // them as a header line.
      frameworks: ['PCI DSS', 'SOC 2'],
      lastScan: { at: '2026-09-20T00:00:00.000Z', entities: 210, passed: 205, warnings: 2, blocked: 3 },
    });
  });

  it('says nothing but counts, a date and framework labels', async () => {
    results.push(RULES, EXEMPTIONS, SCANS, RULES);
    await call();
    // No rule names, entity ids or exemption reasons: the org's policy text is not
    // reporting's business, and the people who need it already have a dashboard.
    expect(Object.keys(payload()).sort()).toEqual(['activeExemptions', 'activeRules', 'frameworks', 'lastScan']);
  });

  it('reports a never-scanned org as a NULL scan, not a zeroed one', async () => {
    results.push(RULES, EXEMPTIONS, [], RULES);
    await call();
    // "Never scanned" and "scanned, nothing blocked" are different facts, and a zeroed
    // scan would read as the second.
    expect(payload().lastScan).toBeNull();
    expect(payload().activeRules).toBe(3);
  });

  it('runs scoped to the caller\'s own org', async () => {
    results.push([], [{ n: 0 }], [], []);
    await call();
    // The org comes from the TOKEN, so there is no path parameter to disagree with and no
    // way to read a second org's posture by building the wrong URL.
    expect(scopes).toEqual([{ orgId: ORG, isSuperAdmin: false }]);
  });

  it('bounds an active rule by its EFFECTIVE WINDOW', async () => {
    results.push(RULES, EXEMPTIONS, SCANS, RULES);
    await call();
    const rendered = JSON.stringify(wheres[0] ?? {});
    // A rule scheduled for next quarter is not active; counting it would say the org
    // enforces something it does not.
    expect(rendered).toContain('effective_from');
    expect(rendered).toContain('effective_until');
  });

  it('counts only APPROVED, unexpired exemptions', async () => {
    results.push(RULES, EXEMPTIONS, SCANS, RULES);
    await call();
    const rendered = JSON.stringify(wheres[1] ?? {});
    expect(rendered).toContain('status');
    expect(rendered).toContain('expires_at');
  });

  it('reads only COMPLETED scans', async () => {
    results.push(RULES, EXEMPTIONS, SCANS, RULES);
    await call();
    expect(JSON.stringify(wheres[2] ?? {})).toContain('status');
  });

  it('reports zero for an org with no rules at all', async () => {
    results.push([], [], [], []);
    await call();
    expect(payload()).toMatchObject({ activeRules: 0, activeExemptions: 0, frameworks: [], lastScan: null });
  });

  it('drops empty and non-string tags', async () => {
    results.push([{ tags: ['SOC 2', '', null, 7] }], [{ n: 0 }], [], [{ tags: ['SOC 2', '', null, 7] }]);
    await call();
    expect(payload().frameworks).toEqual(['SOC 2']);
  });

  it('answers 500 when the read fails, rather than an empty posture', async () => {
    failNext = true;
    await call();
    // An empty posture would read as "no rules", which is a claim rather than a gap. The
    // caller treats any non-2xx as "unavailable" and the report's panel says so — which
    // costs one panel half, not the run.
    expect(mockSendSuccess).not.toHaveBeenCalled();
    expect(mockSendError).toHaveBeenCalledWith(expect.anything(), 500, expect.stringContaining('could not be read'));
  });
});
