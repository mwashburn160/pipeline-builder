// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Gates of routes/plugin-by-name.ts: plugins:write on every route, the
 * destructive ones behind their own limiter and step-up (in that order, so a
 * rate-limited request never spends a step-up token), a declared audit action,
 * name and batch-id validation, and what each passes to the service.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { stubModule, type AnyFn } from '@pipeline-builder/api-core/testing';
import { apiCoreMock } from './helpers/mock-api-core.js';

const STEP_UP = Object.assign(jest.fn((_q: unknown, _s: unknown, next: () => void) => next()), { __stepUp: true });
jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  requireStepUp: STEP_UP,
  requirePermission: (perm: string) => Object.assign((_q: unknown, _s: unknown, next: () => void) => next(), { __perm: perm }),
  audited: (action: string) => Object.assign((_q: unknown, _s: unknown, next: () => void) => next(), { __audit: action }),
  checkVisibilityWriteAccess: () => 'ok',
  sendSuccess: (res: any, statusCode: number, data?: unknown, message?: string) => res.status(statusCode).json({ success: true, data, message }),
  sendBadRequest: (res: any, message: string) => res.status(400).json({ success: false, message }),
}));

const limiterOpts: unknown[] = [];
jest.unstable_mockModule('@pipeline-builder/api-server', () => stubModule('@pipeline-builder/api-server', {
  rateLimitByOrg: (opts: unknown) => { limiterOpts.push(opts); return Object.assign((_q: unknown, _s: unknown, next: () => void) => next(), { __limit: true }); },
  withRoute: (handler: AnyFn) => async (req: any, res: any) => handler({ req, res, ctx: { log: jest.fn() }, orgId: 'org-1', userId: 'u-1' }),
}));

const mockPreview = jest.fn<AnyFn>(async () => ({ name: 'lint' }));
const mockDelete = jest.fn<AnyFn>(async () => ({ batchId: 'b', deleted: [], skipped: [], cancelled: { builds: 0, remediations: 0 } }));
const mockRestore = jest.fn<AnyFn>(async () => ({ batchId: 'b', done: [], skipped: [] }));
const mockPurge = jest.fn<AnyFn>(async () => ({ batchId: 'b', done: [], skipped: [] }));
jest.unstable_mockModule('../src/services/plugin-name-actions.js', () => ({
  previewDeleteByName: mockPreview, deleteByName: mockDelete, restoreByName: mockRestore, purgeByName: mockPurge,
}));

const { createPluginByNameRoutes } = await import('../src/routes/plugin-by-name.js');
const router = createPluginByNameRoutes({} as never);

function stack(method: string, path: string): any[] {
  const layer = (router as any).stack.find((l: any) => l.route?.path === path && l.route?.methods[method]);
  if (!layer) throw new Error(`no ${method} ${path}`);
  return layer.route.stack.map((s: any) => s.handle);
}
const res = () => {
  const r: any = { statusCode: 0, body: undefined };
  r.status = (n: number) => { r.statusCode = n; return r; };
  r.json = (b: unknown) => { r.body = b; return r; };
  return r;
};
const call = async (method: string, path: string, req: Record<string, unknown>) => {
  const h = stack(method, path);
  const out = res();
  await h[h.length - 1]({ query: {}, params: {}, ...req }, out);
  return out;
};
const BATCH = '0190c0de-0000-7000-8000-000000000001';

beforeEach(() => { jest.clearAllMocks(); });

describe('plugin-by-name route gates', () => {
  it.each([
    ['get', '/by-name/:name/delete-preview', null],
    ['delete', '/by-name/:name', 'plugin.delete-all'],
    ['post', '/by-name/:name/restore', 'plugin.restore-all'],
    ['post', '/by-name/:name/purge', 'plugin.purge-all'],
  ])('%s %s needs plugins:write (and destructive ones: audit, limiter, then step-up)', (method, path, audit) => {
    const h = stack(method, path);
    expect(h[0].__perm).toBe('plugins:write');
    if (audit === null) {
      expect(h.some((x) => x === STEP_UP || x.__limit)).toBe(false);
      return;
    }
    expect(h.find((x) => x.__audit)?.__audit).toBe(audit);
    const limitAt = h.findIndex((x) => x.__limit);
    expect(limitAt).toBeGreaterThan(0);
    expect(h.indexOf(STEP_UP)).toBeGreaterThan(limitAt);
  });

  it('the three destructive routes share the 10 / org / hour limiter', () => {
    expect(limiterOpts).toEqual([expect.objectContaining({ name: 'plugin-by-name-destructive', max: 10, windowMs: 3_600_000 })]);
  });
});

describe('plugin-by-name handlers', () => {
  it('rejects an invalid name', async () => {
    expect((await call('delete', '/by-name/:name', { params: { name: '../etc' } })).statusCode).toBe(400);
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it('the caller it hands the service checks visibility per row and logs warnings', async () => {
    await call('get', '/by-name/:name/delete-preview', { params: { name: 'lint' } });
    const c = mockPreview.mock.calls[0]![1] as { checkWrite: AnyFn; logWarn: AnyFn; parentOrgId: string | null };
    expect(c.checkWrite({ id: 'x' })).toBe('ok');
    expect(() => c.logWarn('m', {})).not.toThrow();
    expect(c.parentOrgId).toBeNull();
  });

  it('says how many were skipped', async () => {
    mockDelete.mockResolvedValueOnce({ batchId: 'b', deleted: [{ id: '1', version: '1' }], skipped: [{ id: '2', version: '2', reason: 'in_use' }], cancelled: { builds: 0, remediations: 0 } });
    const out = await call('delete', '/by-name/:name', { params: { name: 'lint' } });
    expect(out.body.message).toBe('Deleted 1 version(s); 1 skipped.');
    expect((await call('get', '/by-name/:name/delete-preview', { params: { name: '' } })).statusCode).toBe(400);
    expect((await call('post', '/by-name/:name/purge', { params: { name: 'A B' }, query: { batchId: BATCH } })).statusCode).toBe(400);
  });

  it('passes force through to the preview and the delete', async () => {
    await call('get', '/by-name/:name/delete-preview', { params: { name: 'lint' }, query: { force: 'true' } });
    expect(mockPreview).toHaveBeenCalledWith('lint', expect.objectContaining({ orgId: 'org-1', userId: 'u-1' }), { force: true });
    const out = await call('delete', '/by-name/:name', { params: { name: 'lint' } });
    expect(out.statusCode).toBe(200);
    expect(out.body.data).toEqual({ batchId: 'b', deleted: [], skipped: [] });
    expect(mockDelete).toHaveBeenCalledWith('lint', expect.anything(), expect.objectContaining({ force: false }));
  });

  it.each(['restore', 'purge'])('%s requires a valid batchId and acts on that batch', async (action) => {
    expect((await call('post', `/by-name/:name/${action}`, { params: { name: 'lint' } })).statusCode).toBe(400);
    expect((await call('post', `/by-name/:name/${action}`, { params: { name: 'lint' }, query: { batchId: 'nope' } })).statusCode).toBe(400);
    const out = await call('post', `/by-name/:name/${action}`, { params: { name: 'lint' }, query: { batchId: BATCH } });
    expect(out.statusCode).toBe(200);
    expect(action === 'restore' ? mockRestore : mockPurge).toHaveBeenCalledWith('lint', BATCH, expect.anything(), expect.anything());
  });
});
