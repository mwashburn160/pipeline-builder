// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Route-level tests for the observability controllers.
 *
 * Mocks the Prometheus + audit-store client modules and asserts:
 *  - catalog scope gate (fleet-wide keys sysadmin-only, audit trail admin-only)
 *  - 400 for unknown catalog keys / wrong-source key (Prom key on /logs)
 *  - 500 on upstream 4xx (catalog bug, not user input)
 *  - 200 + empty `degraded:true` envelope on upstream unreachable (LEAN deploys
 *    omit prometheus, so reads degrade rather than 502)
 *  - 200 + correct envelope shape for instant + range + audit-store queries
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import type { AnyFn } from '@pipeline-builder/api-core/testing';
import type { Request, Response } from 'express';
import { mockConfig } from './helpers/config-mock.js';
import { controllerHelperMock } from './helpers/controller-helper-mock.js';
import { apiCoreMock } from './helpers/mock-api-core.js';
// sendError + sendSuccess stay real (so res.json shape matches prod).
jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  isSystemAdmin: (req: unknown) => mockIsSystemAdmin(req),
}));

jest.unstable_mockModule('../src/config/index.js', () => mockConfig({ observability: { alertmanagerTimeoutMs: 5000 } }));

// Mocks for the upstream clients
const mockPromQuery = jest.fn<AnyFn>();
const mockPromQueryRange = jest.fn<AnyFn>();

jest.unstable_mockModule('../src/observability/prometheus-client.js', () => ({
  query: (...a: unknown[]) => mockPromQuery(...a),
  queryRange: (...a: unknown[]) => mockPromQueryRange(...a),
}));

// The audit-store panels read platform's MongoDB audit trail.
const mockAuditStore = jest.fn<(...a: unknown[]) => Promise<unknown>>();
jest.unstable_mockModule('../src/observability/audit-store-client.js', () => ({
  queryAuditStore: (...a: unknown[]) => mockAuditStore(...a),
}));

// controller-helper runs FOR REAL (see helpers/controller-helper-mock.ts): its
// `ensureAuthenticated` gate and `getAdminContext` predicates are driven by the request
// fixture, not by spies. Only api-core's `isSystemAdmin` stays mocked (above) —
// platform-admin authority is a JWT claim the controller cannot derive locally.
const mockIsSystemAdmin = jest.fn<(req?: unknown) => boolean>();
jest.unstable_mockModule('../src/helpers/controller-helper.js', () => controllerHelperMock());

// The controller now audits silence create/delete; stub the audit helper so the
// test doesn't pull in the real audit-service / mongoose chain.
jest.unstable_mockModule('../src/helpers/audit.js', () => ({
  audit: jest.fn<AnyFn>(),
}));

const { observabilityQuery, observabilityAuditQuery, observabilityCatalog } = await import('../src/observability/controller.js');


function makeRes(): Response & { _status: number; _body: unknown } {
  const r: any = {
    _status: 200,
    _body: undefined,
    status(code: number) { this._status = code; return this; },
    json(b: unknown) { this._body = b; return this; },
    setHeader: jest.fn<AnyFn>(),
  };
  return r as Response & { _status: number; _body: unknown };
}

/** A signed-in plain member: enough for `ensureAuthenticated`, no admin authority. */
const MEMBER = { sub: 'u1' };
/** An org admin — `isOrgAdmin` reads `role`, so this is what grants org-admin surfaces. */
const ORG_ADMIN = { sub: 'a1', organizationId: 'org-1', role: 'admin' };

/**
 * `user` defaults to a signed-in member; pass `null` for an ANONYMOUS caller
 * (the real `ensureAuthenticated` then 401s), or `ORG_ADMIN` for the admin surfaces.
 */
function makeReq(
  query: Record<string, string> = {},
  user: { sub?: string; organizationId?: string; role?: string } | null = MEMBER,
): Request {
  return { query, user: user ?? undefined } as unknown as Request;
}

beforeEach(() => {
  jest.clearAllMocks();
  // Default: a signed-in caller (via makeReq) who is a platform admin — the
  // broadest case, so most tests need no extra setup.
  mockIsSystemAdmin.mockReturnValue(true);
});

describe('observabilityQuery', () => {
  it('returns 401 when caller is not authenticated', async () => {
    const res = makeRes();
    await observabilityQuery(makeReq({ key: 'plugin_builds_per_min', range: '1h' }, null), res);
    expect(res._status).toBe(401);
    // ensureAuthenticated sends the 401 itself; controller bails without firing a query
    expect(mockPromQuery).not.toHaveBeenCalled();
    expect(mockPromQueryRange).not.toHaveBeenCalled();
  });

  it('proceeds for org admins (non-sysadmin) — relies on $ORG scoping', async () => {
    mockIsSystemAdmin.mockReturnValue(false);
    mockPromQueryRange.mockResolvedValue([]);
    const res = makeRes();
    await observabilityQuery(makeReq({ key: 'plugin_builds_per_min', range: '1h' }), res);
    expect(res._status).toBe(200);
    expect(mockPromQueryRange).toHaveBeenCalled();
  });

  it('returns 400 for an unknown catalog key', async () => {
    const res = makeRes();
    await observabilityQuery(makeReq({ key: 'definitely_not_a_real_query', range: '1h' }), res);
    expect(res._status).toBe(400);
    expect((res._body as { message?: string }).message).toMatch(/Unknown observability query key/);
  });

  it('returns 200 + samples for an instant query', async () => {
    mockPromQuery.mockResolvedValue([
      { time: 1700000000, value: '42', labels: {} },
    ]);
    const res = makeRes();
    await observabilityQuery(makeReq({ key: 'plugin_builds_total_24h', range: '1h' }), res);
    expect(res._status).toBe(200);
    const body = res._body as { success: boolean; data: { samples: unknown[] } };
    expect(body.success).toBe(true);
    expect(body.data.samples).toHaveLength(1);
    expect(mockPromQuery).toHaveBeenCalledTimes(1);
  });

  it('returns 200 + series for a range query, with step auto-scaled', async () => {
    mockPromQueryRange.mockResolvedValue([
      { labels: { status: 'success' }, values: [{ time: 1700000000, value: '1' }] },
    ]);
    const res = makeRes();
    await observabilityQuery(makeReq({ key: 'plugin_builds_per_min', range: '6h' }), res);
    expect(res._status).toBe(200);
    const body = res._body as { data: { series: unknown[]; step: string; range: string } };
    expect(body.data.step).toBe('60s'); // 6h → 1m
    expect(body.data.range).toBe('6h');
    expect(body.data.series).toHaveLength(1);
  });

  it('defaults to 1h range when none specified', async () => {
    mockPromQueryRange.mockResolvedValue([]);
    const res = makeRes();
    await observabilityQuery(makeReq({ key: 'plugin_builds_per_min' }), res);
    expect(res._status).toBe(200);
    const body = res._body as { data: { step: string } };
    expect(body.data.step).toBe('15s'); // 1h → 15s
  });

  it('returns 500 on upstream 4xx (catalog bug, not user input)', async () => {
    mockPromQueryRange.mockRejectedValue({ kind: 'upstream-4xx', status: 422, message: 'syntax error' });
    const res = makeRes();
    await observabilityQuery(makeReq({ key: 'plugin_builds_per_min', range: '1h' }), res);
    expect(res._status).toBe(500);
  });

  it('degrades to an empty 200 (degraded:true) when the metrics backend is unreachable', async () => {
    // A LEAN deploy omits Prometheus, so an unreachable backend is expected — a read
    // returns an empty, degraded result instead of a 502 so dashboards render an empty state.
    mockPromQueryRange.mockRejectedValue({ kind: 'unreachable', message: 'ECONNREFUSED' });
    const res = makeRes();
    await observabilityQuery(makeReq({ key: 'plugin_builds_per_min', range: '1h' }), res);
    expect(res._status).toBe(200);
    const body = res._body as { data: { series: unknown[]; degraded?: boolean } };
    expect(body.data.degraded).toBe(true);
    expect(body.data.series).toHaveLength(0);
  });
});

describe('fleet-wide (non-orgScoped) catalog keys require system admin', () => {
  // A non-orgScoped key has NO $ORG confinement — it queries a fleet-wide
  // metric, so anyone but a sysadmin (org admins included) must be 403'd. An
  // orgScoped key stays open to org members ($ORG confines it).

  it('403s an org admin requesting a fleet-wide instant metric (platform_orgs_total)', async () => {
    mockIsSystemAdmin.mockReturnValue(false);
    const res = makeRes();
    await observabilityQuery(makeReq({ key: 'platform_orgs_total' }, ORG_ADMIN), res);
    expect(res._status).toBe(403);
    expect((res._body as { message?: string }).message).toMatch(/system admin/);
    expect(mockPromQuery).not.toHaveBeenCalled();
  });

  it('403s a non-sysadmin requesting a fleet-wide metric (plugin_failed_builds_rate_5m)', async () => {
    mockIsSystemAdmin.mockReturnValue(false);
    const res = makeRes();
    await observabilityQuery(makeReq({ key: 'plugin_failed_builds_rate_5m', range: '1h' }), res);
    expect(res._status).toBe(403);
    expect(mockPromQueryRange).not.toHaveBeenCalled();
  });

  it('allows a SYSADMIN to read a fleet-wide metric', async () => {
    mockPromQuery.mockResolvedValue([]);
    const res = makeRes();
    await observabilityQuery(makeReq({ key: 'platform_orgs_total' }), res);
    expect(res._status).toBe(200);
    expect(mockPromQuery).toHaveBeenCalledWith('max(platform_orgs_total)');
  });

  it('scopes an orgScoped PromQL query to the caller\'s org', async () => {
    mockIsSystemAdmin.mockReturnValue(false);
    mockPromQueryRange.mockResolvedValue([]);
    const res = makeRes();
    await observabilityQuery(makeReq({ key: 'plugin_builds_per_min', range: '1h' }, { organizationId: 'org-1' }), res);
    expect(mockPromQueryRange.mock.calls[0][0]).toContain('org_id="org-1"');
  });

  it('still allows a NON-sysadmin to read an orgScoped key ($ORG confines it)', async () => {
    mockIsSystemAdmin.mockReturnValue(false);
    mockPromQueryRange.mockResolvedValue([]);
    const res = makeRes();
    await observabilityQuery(makeReq({ key: 'plugin_builds_per_min', range: '1h' }), res);
    expect(res._status).toBe(200);
    expect(mockPromQueryRange).toHaveBeenCalledTimes(1);
  });
});

describe('observabilityCatalog', () => {
  const keysOf = (res: { _body: unknown }) =>
    (res._body as { data: { entries: Array<{ key: string }> } }).data.entries.map(e => e.key);

  it('offers a plain org member only the orgScoped, non-admin keys', async () => {
    mockIsSystemAdmin.mockReturnValue(false);
    const res = makeRes();
    await observabilityCatalog(makeReq(), res);
    const keys = keysOf(res);
    expect(keys).toContain('plugin_builds_per_min');
    expect(keys).not.toContain('audit_recent_events');
    expect(keys).not.toContain('platform_orgs_total');
  });

  it('offers an org admin their org-scoped audit trail, but still no fleet-wide keys', async () => {
    mockIsSystemAdmin.mockReturnValue(false);
    const res = makeRes();
    await observabilityCatalog(makeReq({}, ORG_ADMIN), res);
    const keys = keysOf(res);
    expect(keys).toContain('audit_recent_events');
    expect(keys).not.toContain('platform_orgs_total');
  });

  it('offers a sysadmin every key', async () => {
    const res = makeRes();
    await observabilityCatalog(makeReq(), res);
    expect(keysOf(res)).toContain('audit_recent_events');
  });
});

describe('audit trail (audit-store) — org-scoped, admin-only', () => {
  // The admin surface: an org ADMIN by fixture (the real `isOrgAdmin` reads `role`).
  const ORG_USER = ORG_ADMIN;

  beforeEach(() => {
    mockIsSystemAdmin.mockReturnValue(false);
    mockAuditStore.mockResolvedValue({ kind: 'stream', entries: [{ time: '1', line: 'pipeline:p1', labels: {} }] });
  });

  it('403s a plain org member (the audit trail is an admin surface)', async () => {
    const res = makeRes();
    await observabilityAuditQuery(makeReq({ key: 'audit_recent_events', range: '1h' }, { sub: 'm1', organizationId: 'org-1' }), res);
    expect(res._status).toBe(403);
    expect(mockAuditStore).not.toHaveBeenCalled();
  });

  it('serves an org admin their own org\'s trail, with allowed filters passed through', async () => {
    const res = makeRes();
    await observabilityAuditQuery(
      makeReq({ key: 'audit_recent_events', range: '6h', event: 'pipeline.delete', actor: 'u@x.com', requestId: 'r-1' }, ORG_USER),
      res,
    );
    expect(res._status).toBe(200);
    expect((res._body as { data: { entries: unknown[] } }).data.entries).toHaveLength(1);
    const [name, scope, params] = mockAuditStore.mock.calls[0] as [string, unknown, { range: string; limit: number; vars: unknown }];
    expect(name).toBe('recent_events');
    expect(scope).toEqual({ isSuperAdmin: false, orgId: 'org-1' });
    expect(params.range).toBe('6h');
    expect(params.limit).toBe(50);
    expect(params.vars).toEqual({ event: 'pipeline.delete', actor: 'u@x.com', requestId: 'r-1' });
  });

  it('gives a sysadmin the unscoped (every-org) view', async () => {
    mockIsSystemAdmin.mockReturnValue(true);
    const res = makeRes();
    await observabilityAuditQuery(makeReq({ key: 'audit_recent_events', range: '1h' }, { organizationId: 'system' }), res);
    expect(res._status).toBe(200);
    expect((mockAuditStore.mock.calls[0] as unknown[])[1]).toEqual({ isSuperAdmin: true, orgId: 'system' });
  });

  it('returns the matrix envelope for aggregate entries, on /logs and /query alike', async () => {
    mockAuditStore.mockResolvedValue({ kind: 'matrix', series: [{ labels: { event: 'pipeline.create' }, values: [] }], step: '1800s' });
    for (const handler of [observabilityAuditQuery, observabilityQuery]) {
      const res = makeRes();
      await handler(makeReq({ key: 'audit_events_per_hour_by_event', range: '6h' }, ORG_USER), res);
      expect(res._status).toBe(200);
      expect((res._body as { data: unknown }).data).toEqual({
        series: [{ labels: { event: 'pipeline.create' }, values: [] }],
        range: '6h',
        step: '1800s',
      });
    }
  });

  it('drops filters the entry does not allow', async () => {
    mockAuditStore.mockResolvedValue({ kind: 'matrix', series: [], step: '86400s' });
    const res = makeRes();
    await observabilityAuditQuery(makeReq({ key: 'audit_top_actors_24h', event: 'pipeline.delete' }, ORG_USER), res);
    expect(((mockAuditStore.mock.calls[0] as unknown[])[2] as { vars: { event?: string } }).vars.event).toBeUndefined();
  });

  it('400s an invalid range before touching the store', async () => {
    const res = makeRes();
    await observabilityAuditQuery(makeReq({ key: 'audit_recent_events', range: '7d' }, ORG_USER), res);
    expect(res._status).toBe(400);
    expect(mockAuditStore).not.toHaveBeenCalled();
  });
});

describe('observabilityAuditQuery', () => {
  const ORG_USER = ORG_ADMIN;

  beforeEach(() => {
    mockAuditStore.mockResolvedValue({ kind: 'stream', entries: [] });
  });

  it('returns 401 when caller is not authenticated', async () => {
    const res = makeRes();
    await observabilityAuditQuery(makeReq({ key: 'audit_recent_events', range: '1h' }, null), res);
    expect(res._status).toBe(401);
    expect(mockAuditStore).not.toHaveBeenCalled();
  });

  it('returns 400 for a Prometheus key (the endpoint serves only the audit trail)', async () => {
    const res = makeRes();
    await observabilityAuditQuery(makeReq({ key: 'plugin_builds_per_min', range: '1h' }), res);
    expect(res._status).toBe(400);
    expect((res._body as { message?: string }).message).toMatch(/not an audit-trail query/);
    expect(mockPromQueryRange).not.toHaveBeenCalled();
  });

  it('clamps limit to 500 when caller asks for more', async () => {
    const res = makeRes();
    await observabilityAuditQuery(makeReq({ key: 'audit_recent_events', range: '1h', limit: '99999' }, ORG_USER), res);
    expect(((mockAuditStore.mock.calls[0] as unknown[])[2] as { limit: number }).limit).toBe(500);
  });

  it('defaults limit to 50 when missing', async () => {
    const res = makeRes();
    await observabilityAuditQuery(makeReq({ key: 'audit_recent_events', range: '1h' }, ORG_USER), res);
    expect(((mockAuditStore.mock.calls[0] as unknown[])[2] as { limit: number }).limit).toBe(50);
  });
});
