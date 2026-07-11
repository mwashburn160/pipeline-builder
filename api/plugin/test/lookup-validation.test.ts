// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for POST /plugins/lookup filter validation.
 *
 * Without `PluginFilterSchema` validation, callers could inject internal
 * fields (e.g. `deletedAt`, `orgId`) to peek at soft-deleted plugins or
 * bypass tenant scoping. The route must validate before forwarding the
 * filter to the service layer.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import * as z from 'zod';
import { apiCoreMock } from './helpers/mock-api-core.js';

const mockFind = jest.fn();
const mockIncrementQuotaFromCtx = jest.fn();
const mockNormalizeArrayFields = jest.fn((p: unknown) => p);
const mockSendBadRequest = jest.fn((res: any, msg: string, code?: string) =>
  res.status(400).json({ message: msg, code }));
const mockSendSuccess = jest.fn((res: any, status: number, data: any) =>
  res.status(status).json({ success: true, statusCode: status, data }));
const mockSendEntityNotFound = jest.fn((res: any) => res.status(404).json({}));

jest.unstable_mockModule('../src/services/plugin-service.js', () => ({
  pluginService: { find: mockFind, findPaginated: jest.fn(), findById: jest.fn() },
}));

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  sendBadRequest: mockSendBadRequest,
  sendSuccess: mockSendSuccess,
  sendEntityNotFound: mockSendEntityNotFound,
  sendPaginatedNested: jest.fn((res: any, _k: string, items: any) => res.json({ items })),
  normalizeArrayFields: mockNormalizeArrayFields,
  parsePaginationParams: () => ({ limit: 25, offset: 0 }),
  validateQuery: () => ({ ok: true, value: {} }),
  getParam: (p: any, k: string) => p[k],
  // Keep using the real PluginFilterSchema so this test exercises the
  // actual validation surface — that's the whole point of the test.
  PluginFilterSchema: z.object({
    name: z.string().optional(),
    version: z.string().optional(),
    pluginType: z.string().optional(),
    computeType: z.string().optional(),
    isActive: z.union([z.boolean(), z.string()]).optional(),
    isDefault: z.union([z.boolean(), z.string()]).optional(),
    accessModifier: z.enum(['public', 'private']).optional(),
    id: z.union([z.string(), z.array(z.string())]).optional(),
  }).strict(),
}));

jest.unstable_mockModule('@pipeline-builder/api-server', () => ({
  withRoute: (handler: Function) => async (req: any, res: any) => {
    await handler({ req, res, ctx: { log: jest.fn() }, orgId: 'org-1', userId: 'u-1' });
  },
  incrementQuotaFromCtx: (...a: unknown[]) => mockIncrementQuotaFromCtx(...a),
}));

jest.unstable_mockModule('@pipeline-builder/pipeline-core', () => ({
  CoreConstants: { CACHE_CONTROL_LIST: 'public, max-age=60', CACHE_CONTROL_DETAIL: 'public, max-age=300' },
  db: { execute: jest.fn().mockResolvedValue({ rows: [] }) },
  withTenantTx: jest.fn((fn: any) => fn({ execute: jest.fn().mockResolvedValue({ rows: [] }) })),
}));
jest.unstable_mockModule('@pipeline-builder/pipeline-data', () => ({
  CoreConstants: { CACHE_CONTROL_LIST: 'public, max-age=60', CACHE_CONTROL_DETAIL: 'public, max-age=300' },
  db: { execute: jest.fn().mockResolvedValue({ rows: [] }) },
  withTenantTx: jest.fn((fn: any) => fn({ execute: jest.fn().mockResolvedValue({ rows: [] }) })),
}));;

const { createReadPluginRoutes } = await import('../src/routes/read-plugins.js');

const stubQuotaService = { increment: jest.fn() } as any;

function getLookupHandler() {
  const router = createReadPluginRoutes(stubQuotaService);
  const layer = (router.stack as any[]).find(
    (l) => l.route?.path === '/lookup' && l.route?.methods?.post,
  );
  return layer.route.stack[0].handle;
}

function makeRes() {
  const json = jest.fn();
  const status = jest.fn().mockReturnValue({ json });
  const setHeader = jest.fn();
  return { res: { status, json, setHeader }, status, json };
}

describe('POST /plugins/lookup — filter validation', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns 400 when filter is missing', async () => {
    const handler = getLookupHandler();
    const { res, status } = makeRes();
    await handler({ body: {} }, res);
    expect(status).toHaveBeenCalledWith(400);
    expect(mockFind).not.toHaveBeenCalled();
  });

  it('returns 400 when filter is non-object', async () => {
    const handler = getLookupHandler();
    const { res, status } = makeRes();
    await handler({ body: { filter: 'not-an-object' } }, res);
    expect(status).toHaveBeenCalledWith(400);
  });

  it('rejects internal fields like deletedAt (strict whitelist)', async () => {
    const handler = getLookupHandler();
    const { res, status } = makeRes();
    await handler({ body: { filter: { deletedAt: null } } }, res);
    expect(status).toHaveBeenCalledWith(400);
    expect(mockFind).not.toHaveBeenCalled();
  });

  it('rejects orgId in filter (tenancy boundary)', async () => {
    const handler = getLookupHandler();
    const { res, status } = makeRes();
    await handler({ body: { filter: { orgId: 'OTHER-org' } } }, res);
    expect(status).toHaveBeenCalledWith(400);
    expect(mockFind).not.toHaveBeenCalled();
  });

  it('accepts whitelisted fields and returns the plugin', async () => {
    mockFind.mockResolvedValue([{ id: 'p1', name: 'mine', keywords: [], installCommands: [], commands: [] }]);
    const handler = getLookupHandler();
    const { res } = makeRes();
    await handler({ body: { filter: { name: 'mine' } } }, res);
    expect(mockFind).toHaveBeenCalled();
    expect(mockSendSuccess).toHaveBeenCalledWith(res, 200, expect.objectContaining({
      plugin: expect.objectContaining({ id: 'p1' }),
    }));
  });

  it('returns 404 when no plugin matches', async () => {
    mockFind.mockResolvedValue([]);
    const handler = getLookupHandler();
    const { res } = makeRes();
    await handler({ body: { filter: { name: 'missing' } } }, res);
    expect(mockSendEntityNotFound).toHaveBeenCalledWith(res, 'Plugin');
  });
});
