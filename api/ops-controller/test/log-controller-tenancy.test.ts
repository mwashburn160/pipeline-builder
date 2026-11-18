// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tenancy wiring of the Loki logs controller — which org's logs a caller reads,
 * and when a cross-org read is audited. The pure `resolveTenants` is unit-tested
 * in log-query.test.ts; this pins what the HANDLERS pass to Loki:
 *   - a member gets their own org whatever `?orgs=` says;
 *   - a sysadmin defaults to `_infra` (no audit), and reading another tenant is
 *     audited as `observability.logs.cross-org-read`;
 *   - `orgs=all` lists LIVE orgs, sorted, leaving room for `_infra` under the
 *     cap, and says when it was truncated;
 *   - export is refused under read-only impersonation.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { mockConfig } from './helpers/config-mock.js';
import { apiCoreMock } from './helpers/mock-api-core.js';

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  isSystemAdmin: (req: { user?: { isSuperAdmin?: boolean } }) => req.user?.isSuperAdmin === true,
}));
const queryLogs = jest.fn(async (..._a: unknown[]) => [] as unknown[]);
const queryLogVolume = jest.fn(async (..._a: unknown[]) => [] as unknown[]);
jest.unstable_mockModule('../src/observability/loki-client.js', () => ({
  queryLogs: (...a: unknown[]) => queryLogs(...a),
  queryLogVolume: (...a: unknown[]) => queryLogVolume(...a),
  iterateLogs: async function* () { /* nothing */ },
}));
jest.unstable_mockModule('../src/config/index.js', () => mockConfig({ observability: {} }));
const audit = jest.fn();
jest.unstable_mockModule('../src/helpers/audit.js', () => ({ audit: (...a: unknown[]) => audit(...a) }));
jest.unstable_mockModule('../src/helpers/controller-helper.js', () => ({
  ensureAuthenticated: (req: { user?: unknown }) => !!req.user,
  withController: (_l: string, fn: unknown) => fn,
}));
let orgRows: Array<{ _id: string }> = [];
const orgFind = jest.fn();
const orgQuery = { sort: (..._a: unknown[]) => orgQuery, limit: (n: number) => ({ lean: async () => orgRows.slice(0, n) }) };
jest.unstable_mockModule('../src/models/organization.js', () => ({
  __esModule: true,
  default: { find: (...a: unknown[]) => { orgFind(...a); return orgQuery; } },
}));

const ctl = await import('../src/observability/log-controller.js');
const { MAX_TENANTS_PER_QUERY } = await import('../src/observability/log-query.js');

type Handler = (req: unknown, res: unknown) => Promise<void>;
function call(handler: unknown, user: Record<string, unknown> | undefined, query: Record<string, string> = {}) {
  const res: Record<string, unknown> & { statusCode?: number; body?: unknown } = {};
  Object.assign(res, {
    status(c: number) { res.statusCode = c; return res; },
    json(b: unknown) { res.body = b; return res; },
    send(b: unknown) { res.body = b; return res; },
    setHeader() { return res; },
    write() { return true; },
    end() { return res; },
    once() { return res; },
  });
  return (handler as Handler)({ user, query: { range: '1h', ...query }, headers: {} }, res).then(() => res);
}
const tenantOf = () => queryLogs.mock.calls[0][1];

const MEMBER = { sub: 'u1', organizationId: 'org-a', isSuperAdmin: false };
const SYSADMIN = { sub: 'root', organizationId: 'system', isSuperAdmin: true };

beforeEach(() => {
  queryLogs.mockClear();
  queryLogVolume.mockClear();
  audit.mockClear();
  orgFind.mockClear();
  orgRows = [];
});

describe('log search tenancy', () => {
  it('a member reads only their own org, even when asking for another', async () => {
    await call(ctl.logSearch, MEMBER, { orgs: 'org-b' });
    expect(tenantOf()).toBe('org-a');
    expect(audit).not.toHaveBeenCalled();
  });

  it('a sysadmin defaults to _infra, unaudited', async () => {
    await call(ctl.logSearch, SYSADMIN);
    expect(tenantOf()).toBe('_infra');
    expect(audit).not.toHaveBeenCalled();
  });

  it("a sysadmin reading another org's logs is audited as a cross-org read", async () => {
    await call(ctl.logSearch, SYSADMIN, { orgs: 'org-b' });
    expect(tenantOf()).toBe('org-b');
    expect(audit).toHaveBeenCalledWith(expect.anything(), 'observability.logs.cross-org-read', expect.objectContaining({
      targetId: 'org-b', details: { tenantCount: 1, context: 'search' },
    }));
  });

  it('context and raw audit the cross-org read too', async () => {
    await call(ctl.logContext, SYSADMIN, { orgs: 'org-b', at: String(Date.now()) });
    await call(ctl.logRaw, SYSADMIN, { orgs: 'org-b' });
    expect(audit.mock.calls.map((c) => (c[2] as { details: { context: string } }).details.context)).toEqual(['context', 'raw']);
  });

  it('volume (counts only, paired with an audited search) is not audited', async () => {
    await call(ctl.logVolume, SYSADMIN, { orgs: 'org-b' });
    expect(queryLogVolume.mock.calls[0][1]).toBe('org-b');
    expect(audit).not.toHaveBeenCalled();
  });
});

describe('orgs=all', () => {
  it('lists live orgs in id order and leaves room for _infra', async () => {
    orgRows = [{ _id: 'o1' }, { _id: 'o2' }];
    const res = await call(ctl.logSearch, SYSADMIN, { orgs: 'all' });
    expect(orgFind).toHaveBeenCalledWith({ deletedAt: null }, { _id: 1 });
    expect(tenantOf()).toBe('_infra|o1|o2');
    expect((res.body as { data?: { tenantsTruncated?: boolean } }).data?.tenantsTruncated).toBeUndefined();
  });

  it('at fleet size it truncates under the cap (instead of refusing) and says so', async () => {
    orgRows = Array.from({ length: MAX_TENANTS_PER_QUERY + 5 }, (_, i) => ({ _id: `o${String(i).padStart(3, '0')}` }));
    const res = await call(ctl.logSearch, SYSADMIN, { orgs: 'all' });
    expect(String(tenantOf()).split('|')).toHaveLength(MAX_TENANTS_PER_QUERY);
    expect(JSON.stringify(res.body)).toContain('"tenantsTruncated":true');
  });
});

describe('log export', () => {
  it('is refused during a read-only impersonation session', async () => {
    const res = await call(ctl.logExport, { ...MEMBER, impersonationReadOnly: true });
    expect(res.statusCode).toBe(403);
  });
});
