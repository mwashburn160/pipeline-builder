// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for routes/version-lifecycle — `POST /plugins/:id/deprecate` and
 * `POST /plugins/:id/yank` (plugin-ecosystem W0.4).
 */

import type { AnyFn } from '@pipeline-builder/api-core/testing';
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { stubModule } from '@pipeline-builder/api-core/testing';
import { apiCoreMock } from './helpers/mock-api-core.js';

const mockRequireVisibilityWriteAccess = jest.fn((_req: any, _res: any, _resource: any, _u: any, _p: any) => true);

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  getParam: (params: Record<string, string>, key: string) => params[key],
  requireVisibilityWriteAccess: mockRequireVisibilityWriteAccess,
}));

jest.unstable_mockModule('@pipeline-builder/api-server', () => stubModule('@pipeline-builder/api-server', {
  withRoute: (fn: Function) => async (rq: any, rs: any) => {
    try {
      await fn({ req: rq, res: rs, ctx: { log: jest.fn<AnyFn>(), requestId: 'r-1' }, orgId: 'org-1', userId: 'user-1' });
    } catch (err: any) {
      rs.status(err.statusCode ?? 500).json({ success: false, message: err.message, code: err.code });
    }
  },
}));

const mockFindById = jest.fn<(...a: any[]) => Promise<any>>();
const mockSetDeprecated = jest.fn<(...a: any[]) => Promise<any>>();
const mockYankVersion = jest.fn<(...a: any[]) => Promise<any>>();
jest.unstable_mockModule('../src/services/plugin-service.js', () => ({
  pluginService: { findById: mockFindById, setDeprecated: mockSetDeprecated, yankVersion: mockYankVersion },
}));

const mockEmitPluginAudit = jest.fn<AnyFn>();
jest.unstable_mockModule('../src/services/audit.js', () => ({ emitPluginAudit: mockEmitPluginAudit }));

const mockOnPluginDeprecated = jest.fn<AnyFn>();
jest.unstable_mockModule('../src/helpers/deprecation-notice.js', () => ({ onPluginDeprecated: mockOnPluginDeprecated }));

const { createVersionLifecycleRoutes } = await import('../src/routes/version-lifecycle.js');
const { MockConflictError } = await import('@pipeline-builder/api-core/testing');

const router = createVersionLifecycleRoutes();
function handler(path: string) {
  const layer = (router as any).stack.find((l: any) => l.route?.path === path && l.route?.methods.post);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}
function req(body: unknown, id = 'p-1'): any { return { params: { id }, body, query: {}, headers: {} }; }
function res(): any {
  const r: any = {};
  r.status = jest.fn<AnyFn>().mockReturnValue(r);
  r.json = jest.fn<AnyFn>().mockReturnValue(r);
  return r;
}

const row = { id: 'p-1', orgId: 'org-1', name: 'trivy', version: '1.2.0', visibility: 'org', deprecatedAt: null, keywords: [], installCommands: [], commands: [] };

beforeEach(() => { jest.clearAllMocks(); });

describe('POST /plugins/:id/deprecate', () => {
  const deprecate = handler('/:id/deprecate');

  it('deprecates with a message, announces it once and audits it', async () => {
    mockFindById.mockResolvedValue(row);
    mockSetDeprecated.mockResolvedValue({ ...row, deprecatedAt: new Date(), deprecationMessage: 'Use 2.x' });
    const r = res();

    await deprecate(req({ message: 'Use 2.x' }), r);

    expect(mockSetDeprecated).toHaveBeenCalledWith(row, 'org-1', 'user-1', { deprecated: true, message: 'Use 2.x' });
    expect(mockOnPluginDeprecated).toHaveBeenCalledTimes(1);
    expect(mockEmitPluginAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'plugin.version.deprecate', targetId: 'p-1', details: { pluginName: 'trivy', version: '1.2.0', deprecated: true },
    }));
    expect(r.status).toHaveBeenCalledWith(200);
  });

  it('un-deprecates with { deprecated: false } (message dropped, no announcement)', async () => {
    mockFindById.mockResolvedValue({ ...row, deprecatedAt: new Date() });
    mockSetDeprecated.mockResolvedValue(row);

    await deprecate(req({ deprecated: false, message: 'ignored' }), res());

    expect(mockSetDeprecated).toHaveBeenCalledWith(expect.anything(), 'org-1', 'user-1', { deprecated: false, message: null });
    expect(mockOnPluginDeprecated).not.toHaveBeenCalled();
  });

  it('does not re-announce a version that was already deprecated', async () => {
    mockFindById.mockResolvedValue({ ...row, deprecatedAt: new Date() });
    mockSetDeprecated.mockResolvedValue(row);
    await deprecate(req({}), res());
    expect(mockOnPluginDeprecated).not.toHaveBeenCalled();
  });

  it('400s an invalid body, 404s an unknown id, and stops on the visibility ladder', async () => {
    const bad = res();
    await deprecate(req({ message: 'x'.repeat(501) }), bad);
    expect(bad.status).toHaveBeenCalledWith(400);

    mockFindById.mockResolvedValueOnce(null);
    const missing = res();
    await deprecate(req({}), missing);
    expect(missing.status).toHaveBeenCalledWith(404);

    mockFindById.mockResolvedValueOnce(row);
    mockRequireVisibilityWriteAccess.mockReturnValueOnce(false);
    await deprecate(req({}), res());
    expect(mockSetDeprecated).not.toHaveBeenCalled();

    mockFindById.mockResolvedValueOnce(row);
    mockSetDeprecated.mockResolvedValueOnce(null);
    const gone = res();
    await deprecate(req({}), gone);
    expect(gone.status).toHaveBeenCalledWith(404);
  });
});

describe('POST /plugins/:id/yank', () => {
  const yank = handler('/:id/yank');

  it('yanks with a reason, reports the promoted default and audits it', async () => {
    mockFindById.mockResolvedValue({ ...row, isDefault: true });
    mockYankVersion.mockResolvedValue({ yanked: { ...row, lifecycle: 'yanked' }, promoted: { id: 'p-0', version: '1.1.0' } });
    const r = res();

    await yank(req({ reason: 'CVE-2026-0001' }), r);

    expect(mockYankVersion).toHaveBeenCalledWith(expect.objectContaining({ id: 'p-1' }), 'org-1', 'user-1', 'CVE-2026-0001');
    expect(r.json).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ promotedDefault: { id: 'p-0', version: '1.1.0' } }),
    }));
    expect(mockEmitPluginAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'plugin.version.yank', details: { pluginName: 'trivy', version: '1.2.0', promotedDefaultVersion: '1.1.0' },
    }));
  });

  it('requires a reason', async () => {
    const r = res();
    await yank(req({}), r);
    expect(r.status).toHaveBeenCalledWith(400);
    expect(mockYankVersion).not.toHaveBeenCalled();
  });

  it('surfaces the 409 for a version published to the ecosystem', async () => {
    mockFindById.mockResolvedValue(row);
    mockYankVersion.mockRejectedValueOnce(new MockConflictError('published to the ecosystem'));
    const r = res();
    await yank(req({ reason: 'x' }), r);
    expect(r.status).toHaveBeenCalledWith(409);
    expect(mockEmitPluginAudit).not.toHaveBeenCalled();
  });

  it('404s an unknown id or a yank that matched nothing', async () => {
    mockFindById.mockResolvedValueOnce(null);
    const a = res();
    await yank(req({ reason: 'x' }), a);
    expect(a.status).toHaveBeenCalledWith(404);

    mockFindById.mockResolvedValueOnce(row);
    mockYankVersion.mockResolvedValueOnce({ yanked: null, promoted: null });
    const b = res();
    await yank(req({ reason: 'x' }), b);
    expect(b.status).toHaveBeenCalledWith(404);
  });
});
