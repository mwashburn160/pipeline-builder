// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The install / consumption-policy / catalog route handlers (routes/installs.ts):
 * each hands the acting caller, its params and body to the install service and
 * answers with the result; an `EcosystemError` becomes its code AND its
 * structured details (the refusal `reason`). The gates themselves — the new
 * `plugins:install` / `plugin_installs:manage` permissions and the policy
 * step-up — are checked against the real route table in route-coverage.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  requireStepUp: (_req: unknown, _res: unknown, next: () => void) => next(),
  sendError: (res: any, statusCode: number, message: string, code?: string, details?: unknown) =>
    res.status(statusCode).json({ success: false, message, code, ...(details ? { details } : {}) }),
}));
jest.unstable_mockModule('@pipeline-builder/api-server', () => ({
  withRoute: (fn: (a: unknown) => Promise<void>) => async (rq: any, rs: any) => {
    try {
      await fn({ req: rq, res: rs, ctx: { log: jest.fn() }, orgId: 'org-b', userId: 'u-b' });
    } catch (err: any) {
      rs.status(500).json({ success: false, message: err.message });
    }
  },
}));

const names = ['approveInstall', 'catalog', 'createInstall', 'denyInstall', 'getPolicy', 'installState', 'listInstalls', 'putPolicy', 'removeInstall', 'shadowing', 'updateInstall'] as const;
const svc = Object.fromEntries(names.map((n) => [n, jest.fn(async () => ({ ok: n }))])) as Record<typeof names[number], ReturnType<typeof jest.fn>>;
jest.unstable_mockModule('../src/services/ecosystem/installs.js', () => svc);

const { createInstallRoutes } = await import('../src/routes/installs.js');
const { EcosystemError } = await import('../src/services/ecosystem/context.js');

type Layer = { route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: (...a: any[]) => any }> } };
const router = createInstallRoutes();

async function call(method: string, path: string, req: Record<string, unknown> = {}) {
  const layer = (router as unknown as { stack: Layer[] }).stack.find((l) => l.route?.path === path && l.route.methods[method]);
  if (!layer) throw new Error(`no ${method} ${path}`);
  const handlers = layer.route!.stack.map((s) => s.handle);
  const res: any = { statusCode: 0, body: undefined };
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (b: unknown) => { res.body = b; return res; };
  const request = {
    params: {},
    query: {},
    body: {},
    headers: {},
    user: { sub: 'u-b', organizationId: 'ORG-B', parentOrganizationId: 'ROOT', principalType: 'user', username: 'bob', permissions: ['plugins:read', 'plugins:install'], features: [] },
    ...req,
  };
  await handlers[handlers.length - 1]!(request, res, () => undefined);
  return res;
}

beforeEach(() => jest.clearAllMocks());

describe('install routes', () => {
  const caller = expect.objectContaining({ userId: 'u-b', orgId: 'org-b', parentOrgId: 'root', permissions: ['plugins:read', 'plugins:install'] });

  it.each([
    ['get', '/catalog', { query: { q: 'lint' } }, svc.catalog, 200, [caller, { q: 'lint' }]],
    ['get', '/listings/:publisher/:name/install-state', { params: { publisher: 'acme', name: 'lint' } }, svc.installState, 200, [caller, 'acme', 'lint']],
    ['get', '/installs', { query: { status: 'active' } }, svc.listInstalls, 200, [caller, { status: 'active' }]],
    ['post', '/installs', { body: { publisher: 'acme', name: 'lint' } }, svc.createInstall, 201, [caller, { publisher: 'acme', name: 'lint' }]],
    ['patch', '/installs/:id', { params: { id: 'i-1' }, body: { version: '2.0.0' } }, svc.updateInstall, 200, [caller, 'i-1', { version: '2.0.0' }]],
    ['delete', '/installs/:id', { params: { id: 'i-1' } }, svc.removeInstall, 200, [caller, 'i-1']],
    ['post', '/installs/:id/approve', { params: { id: 'i-1' } }, svc.approveInstall, 200, [caller, 'i-1']],
    ['post', '/installs/:id/deny', { params: { id: 'i-1' }, body: { reason: 'no' } }, svc.denyInstall, 200, [caller, 'i-1', 'no']],
    ['get', '/install-policy', {}, svc.getPolicy, 200, [caller]],
    ['put', '/install-policy', { body: { blockOnAdvisory: 'high' } }, svc.putPolicy, 200, [caller, { blockOnAdvisory: 'high' }]],
    ['get', '/shadowing', {}, svc.shadowing, 200, [caller]],
  ])('%s %s hands the caller to the service', async (method, path, req, fn, status, args) => {
    const res = await call(method as string, path as string, req as Record<string, unknown>);
    expect(res.statusCode).toBe(status);
    expect(res.body.data).toEqual({ ok: expect.any(String) });
    expect(fn).toHaveBeenCalledWith(...(args as unknown[]));
  });

  it('tolerates a missing query object', async () => {
    await call('get', '/catalog', { query: undefined });
    expect(svc.catalog).toHaveBeenCalledWith(expect.anything(), {});
  });

  it('answers a refusal with its code and reason', async () => {
    svc.createInstall.mockRejectedValueOnce(new EcosystemError('PLUGIN_BLOCKED_BY_POLICY' as never, 'blocked', { reason: 'tier' }));
    const res = await call('post', '/installs', { body: { publisher: 'acme', name: 'lint' } });
    expect(res.statusCode).toBe(403);
    expect(res.body).toMatchObject({ code: 'PLUGIN_BLOCKED_BY_POLICY', details: { reason: 'tier' } });
  });
});
