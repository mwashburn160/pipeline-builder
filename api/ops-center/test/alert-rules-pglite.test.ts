// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Alert-rule CRUD through the REAL controllers and service against a REAL
 * Postgres (PGlite + the shipped init script, as the application role under
 * RLS + FORCE) — create, list (paged), update, soft delete, restore, purge,
 * plus the refusals: invalid / cross-org PromQL, quota denied, the partial
 * unique index colliding on restore, cross-org isolation, and the route's
 * `observability:write` permission gate.
 *
 * Only the edges that leave the process are stubbed: the feature-quota
 * reservation (platform + quota service) and the audit emitter (platform's
 * ingest). Everything between the handler and the table runs unmodified.
 */

import { jest, describe, it, expect, beforeAll, afterAll, beforeEach } from '@jest/globals';
import { bootTenantDb, type TenantTestDb } from '@pipeline-builder/pipeline-data/testing';
import { featureQuotaMock } from './helpers/feature-quota-mock.js';
import { call, makeRes, type Caller } from './helpers/pglite-controller.js';

process.env.JWT_SECRET ||= 'alert-rules-pglite-test-secret';
process.env.MONGODB_URI ||= 'mongodb://stub:27017/test';
process.env.SECRET_ENCRYPTION_KEY ||= '0'.repeat(64);

type Reservation = { exceeded: boolean; unavailable?: boolean; quota: { limit: number; used: number; remaining: number; resetAt?: string } };
const GRANTED: Reservation = { exceeded: false, quota: { limit: 10, used: 1, remaining: 9 } };
const mockReserve = jest.fn<(orgId: string, type: string) => Promise<Reservation>>();
const mockRelease = jest.fn();
const mockAudit = jest.fn();

jest.unstable_mockModule('../src/middleware/quota.js', () => featureQuotaMock({
  reserveFeatureQuota: (orgId: string, type: string) => mockReserve(orgId, type),
  releaseFeatureQuota: (...a: unknown[]) => mockRelease(...a),
}));
jest.unstable_mockModule('../src/helpers/audit.js', () => ({
  audit: (...a: unknown[]) => mockAudit(...a),
  recordAuditEvent: jest.fn(),
}));

const ctl = await import('../src/controllers/alert-rules.js');
const { requirePermission } = await import('@pipeline-builder/api-core');

let tdb: TenantTestDb;
const owner = <T>(fn: (q: TenantTestDb['pglite']) => Promise<T>) => tdb.asOwner(fn);

const A: Caller = { orgId: 'org-rules-a', userId: 'user-a' };
const B: Caller = { orgId: 'org-rules-b', userId: 'user-b' };

const ruleBody = (over: Record<string, unknown> = {}) => ({
  name: 'HighErrors',
  expr: 'sum(rate(http_requests_total[5m])) > 5',
  summary: 'errors are high',
  severity: 'critical',
  forDuration: '10m',
  ...over,
});

async function createRule(caller: Caller, over: Record<string, unknown> = {}) {
  const res = await call(ctl.createAlertRule, caller, { body: ruleBody(over) });
  expect(res.statusCode).toBe(201);
  return res.body!.data.rule as { id: string; name: string; expr: string; orgId: string; updatedAt: string };
}

beforeAll(async () => {
  tdb = await bootTenantDb();
}, 120_000);

afterAll(async () => {
  await tdb?.close();
});

beforeEach(async () => {
  await owner((q) => q.exec('DELETE FROM org_alert_rules;'));
  mockReserve.mockReset().mockResolvedValue(GRANTED);
  mockRelease.mockReset();
  mockAudit.mockReset();
});

describe('create', () => {
  it('scopes a vanilla expr to the caller\'s org, persists it, reserves quota and audits', async () => {
    const rule = await createRule(A);
    expect(rule.orgId).toBe(A.orgId);
    expect(rule.expr).toContain(`org_id="${A.orgId}"`);
    expect(mockReserve).toHaveBeenCalledWith(A.orgId, 'alertRules');
    expect(mockRelease).not.toHaveBeenCalled();
    expect(mockAudit).toHaveBeenCalledWith(expect.anything(), 'alert.rule.create', expect.objectContaining({
      targetId: rule.id, details: { name: 'HighErrors', severity: 'critical' },
    }));

    const { rows } = await owner((q) => q.query<{ org_id: string; for_duration: string; created_by: string }>(
      'SELECT org_id, for_duration, created_by FROM org_alert_rules WHERE id = $1', [rule.id],
    ));
    expect(rows[0]).toEqual({ org_id: A.orgId, for_duration: '10m', created_by: A.userId });
  });

  it('400s a body missing required fields without touching quota', async () => {
    const res = await call(ctl.createAlertRule, A, { body: { name: 'x' } });
    expect(res.statusCode).toBe(400);
    expect(mockReserve).not.toHaveBeenCalled();
  });

  it('400s an expr that pins a DIFFERENT org (the rewriter refuses it)', async () => {
    const res = await call(ctl.createAlertRule, A, { body: ruleBody({ expr: `up{org_id="${B.orgId}"} == 0` }) });
    expect(res.statusCode).toBe(400);
    expect(mockReserve).not.toHaveBeenCalled();
  });

  it('400s a rule the validator rejects (bad duration)', async () => {
    const res = await call(ctl.createAlertRule, A, { body: ruleBody({ forDuration: '5 minutes' }) });
    expect(res.statusCode).toBe(400);
    expect(res.body?.message).toMatch(/duration/i);
  });

  it('429s when the plan quota is exhausted and writes nothing', async () => {
    mockReserve.mockResolvedValue({ exceeded: true, quota: { limit: 1, used: 1, remaining: 0 } });
    const res = await call(ctl.createAlertRule, A, { body: ruleBody() });
    expect(res.statusCode).toBe(429);
    const { rows } = await owner((q) => q.query('SELECT 1 FROM org_alert_rules'));
    expect(rows).toHaveLength(0);
  });

  it('503s when the quota service cannot confirm the slot', async () => {
    mockReserve.mockResolvedValue({ exceeded: true, unavailable: true, quota: { limit: 1, used: 0, remaining: 1 } });
    const res = await call(ctl.createAlertRule, A, { body: ruleBody() });
    expect(res.statusCode).toBe(503);
  });

  it('a same-name live rule hits the real unique index → 409, and the slot is given back', async () => {
    await createRule(A);
    const res = await call(ctl.createAlertRule, A, { body: ruleBody() });
    expect(res.statusCode).toBe(409);
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });

  it('the same name in ANOTHER org is fine (index is per-org)', async () => {
    await createRule(A);
    await createRule(B);
  });
});

describe('list / pagination / isolation', () => {
  it('pages by name with a hasMore envelope, and never shows another org\'s rules', async () => {
    for (const n of ['Charlie', 'Alpha', 'Bravo']) await createRule(A, { name: n });
    await createRule(B, { name: 'OtherOrg' });

    const p1 = await call(ctl.listAlertRules, A, { query: { offset: '0', limit: '2' } });
    expect(p1.statusCode).toBe(200);
    expect(p1.body!.data.rules.map((r: { name: string }) => r.name)).toEqual(['Alpha', 'Bravo']);
    expect(p1.body!.data.pagination).toEqual({ total: 3, offset: 0, limit: 2, hasMore: true });

    const p2 = await call(ctl.listAlertRules, A, { query: { offset: '2', limit: '2' } });
    expect(p2.body!.data.rules.map((r: { name: string }) => r.name)).toEqual(['Charlie']);
    expect(p2.body!.data.pagination.hasMore).toBe(false);

    const b = await call(ctl.listAlertRules, B);
    expect(b.body!.data.rules.map((r: { name: string }) => r.name)).toEqual(['OtherOrg']);
  });

  it('400s a caller with no organization', async () => {
    const res = await call(ctl.listAlertRules, { orgId: '', userId: 'u' });
    expect(res.statusCode).toBe(400);
  });

  it('RLS hides another org\'s rows even when the service is asked for that org', async () => {
    await createRule(B, { name: 'Secret' });
    // Caller in org A's tenant context, but the request claims org B — the
    // row-level policy, not the WHERE clause, is what hides it.
    const res = makeRes();
    const { asTenantContext } = await import('@pipeline-builder/pipeline-data/testing');
    await asTenantContext({ orgId: A.orgId, userId: A.userId }, () => ctl.listAlertRules(
      { method: 'GET', headers: {}, query: {}, params: {}, user: { sub: A.userId, organizationId: B.orgId } } as never,
      res as never,
    ));
    expect(res.statusCode).toBe(200);
    expect(res.body!.data.rules).toEqual([]);
  });
});

describe('update', () => {
  it('patches the named fields, re-scopes a new expr, and audits', async () => {
    const rule = await createRule(A);
    const res = await call(ctl.updateAlertRule, A, {
      params: { id: rule.id },
      body: { summary: 'new summary', expr: 'up == 0', enabled: false },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body!.data.rule).toMatchObject({ summary: 'new summary', enabled: false, name: 'HighErrors' });
    expect(res.body!.data.rule.expr).toContain(`org_id="${A.orgId}"`);
    expect(mockAudit).toHaveBeenCalledWith(expect.anything(), 'alert.rule.update', expect.objectContaining({ targetId: rule.id }));
  });

  it('400s an expr that targets another org, and an invalid severity', async () => {
    const rule = await createRule(A);
    expect((await call(ctl.updateAlertRule, A, { params: { id: rule.id }, body: { expr: `up{org_id="${B.orgId}"}` } })).statusCode).toBe(400);
    expect((await call(ctl.updateAlertRule, A, { params: { id: rule.id }, body: { name: 'bad/name' } })).statusCode).toBe(400);
    expect((await call(ctl.updateAlertRule, A, { params: { id: rule.id }, body: { severity: 'page' } })).statusCode).toBe(400);
  });

  it('a rename onto a live namesake is a 409 (real partial unique index)', async () => {
    await createRule(A, { name: 'Taken' });
    const mine = await createRule(A, { name: 'Mine' });
    const res = await call(ctl.updateAlertRule, A, { params: { id: mine.id }, body: { name: 'Taken' } });
    expect(res.statusCode).toBe(409);
  });

  it('404s an unknown id', async () => {
    const res = await call(ctl.updateAlertRule, A, { params: { id: '00000000-0000-0000-0000-000000000000' }, body: { summary: 's' } });
    expect(res.statusCode).toBe(404);
  });

  it('404s another org\'s rule (cross-org write refused) and leaves it unchanged', async () => {
    const theirs = await createRule(B);
    const res = await call(ctl.updateAlertRule, A, { params: { id: theirs.id }, body: { summary: 'pwned' } });
    expect(res.statusCode).toBe(404);
    const { rows } = await owner((q) => q.query<{ summary: string }>('SELECT summary FROM org_alert_rules WHERE id = $1', [theirs.id]));
    expect(rows[0]?.summary).toBe('errors are high');
  });
});

describe('delete → restore → purge lifecycle', () => {
  it('soft-deletes (releasing quota), lists the tombstone, restores (re-reserving), and purges', async () => {
    const rule = await createRule(A);

    const del = await call(ctl.deleteAlertRule, A, { params: { id: rule.id } });
    expect(del.statusCode).toBe(200);
    expect(mockRelease).toHaveBeenCalledWith(A.orgId, 'alertRules', expect.any(Function), null);
    expect((await call(ctl.listAlertRules, A)).body!.data.rules).toEqual([]);

    const deleted = await call(ctl.listDeletedAlertRules, A);
    expect(deleted.body!.data.rules.map((r: { id: string }) => r.id)).toEqual([rule.id]);
    // Tombstones are org-scoped too.
    expect((await call(ctl.listDeletedAlertRules, B)).body!.data.rules).toEqual([]);

    // Deleting twice is a 404.
    expect((await call(ctl.deleteAlertRule, A, { params: { id: rule.id } })).statusCode).toBe(404);

    mockReserve.mockClear();
    const restored = await call(ctl.restoreAlertRule, A, { params: { id: rule.id } });
    expect(restored.statusCode).toBe(200);
    expect(mockReserve).toHaveBeenCalledWith(A.orgId, 'alertRules');
    expect((await call(ctl.listAlertRules, A)).body!.data.pagination.total).toBe(1);

    // A LIVE rule cannot be purged — it must be soft-deleted first.
    expect((await call(ctl.purgeAlertRule, A, { params: { id: rule.id } })).statusCode).toBe(404);

    await call(ctl.deleteAlertRule, A, { params: { id: rule.id } });
    const purged = await call(ctl.purgeAlertRule, A, { params: { id: rule.id } });
    expect(purged.statusCode).toBe(200);
    expect(mockAudit).toHaveBeenCalledWith(expect.anything(), 'alert.rule.purge', expect.objectContaining({ details: { name: 'HighErrors' } }));
    const { rows } = await owner((q) => q.query('SELECT 1 FROM org_alert_rules WHERE id = $1', [rule.id]));
    expect(rows).toHaveLength(0);
  });

  it('restore of an unknown id is a 404 that gives the reserved slot back', async () => {
    const res = await call(ctl.restoreAlertRule, A, { params: { id: '00000000-0000-0000-0000-000000000000' } });
    expect(res.statusCode).toBe(404);
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });

  it('restore that collides with a live namesake is a 409 and releases the slot', async () => {
    const first = await createRule(A);
    await call(ctl.deleteAlertRule, A, { params: { id: first.id } });
    await createRule(A); // same name, now live
    mockRelease.mockClear();

    const res = await call(ctl.restoreAlertRule, A, { params: { id: first.id } });
    expect(res.statusCode).toBe(409);
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });

  it('restore under an exhausted quota is refused before the row changes', async () => {
    const rule = await createRule(A);
    await call(ctl.deleteAlertRule, A, { params: { id: rule.id } });
    mockReserve.mockResolvedValue({ exceeded: true, quota: { limit: 1, used: 1, remaining: 0 } });
    expect((await call(ctl.restoreAlertRule, A, { params: { id: rule.id } })).statusCode).toBe(429);
    const { rows } = await owner((q) => q.query<{ deleted_at: Date | null }>('SELECT deleted_at FROM org_alert_rules WHERE id = $1', [rule.id]));
    expect(rows[0]?.deleted_at).not.toBeNull();
  });

  it('another org can neither delete, restore nor purge my rule', async () => {
    const rule = await createRule(A);
    expect((await call(ctl.deleteAlertRule, B, { params: { id: rule.id } })).statusCode).toBe(404);
    await call(ctl.deleteAlertRule, A, { params: { id: rule.id } });
    expect((await call(ctl.restoreAlertRule, B, { params: { id: rule.id } })).statusCode).toBe(404);
    expect((await call(ctl.purgeAlertRule, B, { params: { id: rule.id } })).statusCode).toBe(404);
    const { rows } = await owner((q) => q.query('SELECT 1 FROM org_alert_rules WHERE id = $1', [rule.id]));
    expect(rows).toHaveLength(1);
  });

  it('401s every mutation without an authenticated user', async () => {
    for (const h of [ctl.createAlertRule, ctl.updateAlertRule, ctl.deleteAlertRule, ctl.restoreAlertRule, ctl.purgeAlertRule]) {
      const res = makeRes();
      await h({ headers: {}, params: { id: 'x' }, body: {}, query: {} } as never, res as never);
      expect(res.statusCode).toBe(401);
    }
  });
});

describe('materializer', () => {
  it('refuses a non-sysadmin, and renders every org\'s ENABLED rules for a sysadmin', async () => {
    await createRule(A, { name: 'OnA' });
    await createRule(B, { name: 'OnB' });
    await createRule(B, { name: 'Disabled', enabled: false });

    expect((await call(ctl.materializeAlertRules, A)).statusCode).toBe(403);

    const res = await call(ctl.materializeAlertRules, { orgId: A.orgId, userId: 'root', isSuperAdmin: true });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/yaml/);
    expect(res.sent).toContain('OrgRule_org_rules_a_OnA');
    expect(res.sent).toContain('OrgRule_org_rules_b_OnB');
    expect(res.sent).not.toContain('Disabled');
  });
});

describe('route permission gate (requirePermission(observability:write))', () => {
  const gate = requirePermission('observability:write');
  it('refuses a member without the write capability, admits one holding it', () => {
    const denied = makeRes();
    const next = jest.fn();
    gate({ method: 'POST', headers: {}, user: { sub: 'm', organizationId: A.orgId, permissions: ['observability:read'] } } as never, denied as never, next);
    expect(next).not.toHaveBeenCalled();
    expect(denied.statusCode).toBe(403);

    const ok = makeRes();
    gate({ method: 'POST', headers: {}, user: { sub: 'a', organizationId: A.orgId, permissions: ['observability:write'] } } as never, ok as never, next);
    expect(next).toHaveBeenCalledTimes(1);
  });
});
