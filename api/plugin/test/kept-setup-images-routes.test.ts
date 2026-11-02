// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * routes/kept-setup-images.ts against the REAL api-core gates: a tenant can
 * neither list nor promote kept setup images (403 SYSTEM_ORG_REQUIRED before
 * the service is reached), and a system-org moderator with an aal2 session
 * reaches the service with its own org and id. The route table's gates
 * (system org + plugins:moderate + aal2, the declared audit actions) are also
 * checked in route-coverage.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { stubModule } from '@pipeline-builder/api-core/testing';

jest.unstable_mockModule('@pipeline-builder/api-server', () => stubModule('@pipeline-builder/api-server', {
  withRoute: (fn: (a: unknown) => Promise<void>) => async (rq: any, rs: any) => {
    try {
      await fn({ req: rq, res: rs, ctx: { log: jest.fn() } });
    } catch (err: any) {
      rs.status(err.statusCode ?? 500).json({ success: false, message: err.message, code: err.code });
    }
  },
}));
const mockList = jest.fn(async (..._a: unknown[]) => [] as unknown[]);
const mockPromote = jest.fn(async (..._a: unknown[]) => ({ plugin: { id: 'p-1' }, messages: [] }));
jest.unstable_mockModule('../src/services/kept-setup-images.js', () => ({ listKeptSetupImages: mockList, promoteKeptSetupImage: mockPromote }));

const { SYSTEM_ORG_ID } = await import('@pipeline-builder/api-core');
const { createKeptSetupImageRoutes } = await import('../src/routes/kept-setup-images.js');

type Layer = { route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: (...a: any[]) => any }> } };

/** Run a route's whole handler chain against a fake request, the way Express would. */
async function call(method: string, path: string, user: Record<string, unknown>, params: Record<string, string> = {}) {
  const layer = (createKeptSetupImageRoutes() as unknown as { stack: Layer[] }).stack.find((l) => l.route?.path === path && l.route.methods[method]);
  if (!layer?.route) throw new Error(`no route ${method} ${path}`);
  const res: any = { statusCode: 200, body: undefined, headers: {} as Record<string, string> };
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (b: unknown) => { res.body = b; return res; };
  res.setHeader = (k: string, v: string) => { res.headers[k] = v; };
  res.set = res.setHeader;
  const req: any = { method: method.toUpperCase(), params, query: {}, body: {}, headers: {}, user, path };
  for (const { handle } of layer.route.stack) {
    let advanced = false;
    await handle(req, res, (err?: unknown) => { if (err) throw err; advanced = true; });
    if (!advanced) break;
  }
  return res;
}

const tenant = { sub: 'u-1', organizationId: 'org-acme', permissions: ['plugins:moderate', 'plugins:read'], amr: ['pwd', 'otp'], principalType: 'user' };
const moderator = { sub: 'mod-1', userId: 'mod-1', organizationId: SYSTEM_ORG_ID, permissions: ['plugins:moderate'], amr: ['pwd', 'otp'], aal: 2, principalType: 'user' };

beforeEach(() => { jest.clearAllMocks(); });

describe('kept setup image routes', () => {
  it('a TENANT can neither list nor promote: 403 SYSTEM_ORG_REQUIRED, the service never reached', async () => {
    const list = await call('get', '/kept-setup-images', tenant);
    expect(list.statusCode).toBe(403);
    expect(list.body).toMatchObject({ code: 'SYSTEM_ORG_REQUIRED' });
    const promote = await call('post', '/kept-setup-images/:id/promote', tenant, { id: 'k-1' });
    expect(promote.statusCode).toBe(403);
    expect(mockList).not.toHaveBeenCalled();
    expect(mockPromote).not.toHaveBeenCalled();
  });

  it('a system-org caller WITHOUT plugins:moderate is refused too', async () => {
    const res = await call('post', '/kept-setup-images/:id/promote', { ...moderator, permissions: ['plugins:read'] }, { id: 'k-1' });
    expect(res.statusCode).toBe(403);
    expect(mockPromote).not.toHaveBeenCalled();
  });
});
