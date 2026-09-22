// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for routes/update-plugin.
 *
 * Extracts route handlers from the router and tests them directly
 * with mock req/res objects — no HTTP server needed.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import type { AnyFn } from '@pipeline-builder/api-core/testing';
import { stubModule } from '@pipeline-builder/api-core/testing';
import { apiCoreMock } from './helpers/mock-api-core.js';

// Mocks — must be defined before imports

const mockIsSystemAdmin = jest.fn((_req?: any) => false);
const mockSendBadRequestForRoute = jest.fn((res: any, msg: string) => {
  res.status(400).json({ success: false, statusCode: 400, message: msg });
});
const mockSendInternalErrorForRoute = jest.fn((res: any, msg: string) => {
  res.status(500).json({ success: false, statusCode: 500, message: msg });
});

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  getParam: jest.fn((params: Record<string, string>, key: string) => params[key]),
  isSystemAdmin: mockIsSystemAdmin,
  requireVisibilityWriteAccess: jest.fn((_req: any, _res: any, _resource: any) => true),
  resolveVisibility: jest.fn((_req: any, am?: string) => am || 'private'),
  pickDefined: jest.fn((obj: any) => {
    const result: any = {};
    for (const [k, v] of Object.entries(obj)) {
      if (v !== undefined) result[k] = v;
    }
    return result;
  }),
  sendSuccess: jest.fn((res: any, statusCode: number, data?: any, message?: string) => {
    const response: any = { success: true, statusCode };
    if (data !== undefined) response.data = data;
    if (message) response.message = message;
    res.status(statusCode).json(response);
  }),
  sendBadRequest: jest.fn((res: any, msg: string, code?: string) => {
    res.status(400).json({ success: false, statusCode: 400, message: msg, code });
  }),
  sendError: jest.fn((res: any, status: number, msg: string, code?: string) => {
    res.status(status).json({ success: false, statusCode: status, message: msg, code });
  }),
  sendInternalError: jest.fn((res: any, msg: string) => {
    res.status(500).json({ success: false, statusCode: 500, message: msg });
  }),
  normalizeArrayFields: jest.fn((p: any) => p),
  sendEntityNotFound: jest.fn((res: any, entity: string) => {
    res.status(404).json({ success: false, statusCode: 404, message: `${entity} not found.` });
  }),
}));

jest.unstable_mockModule('@pipeline-builder/api-server', () => stubModule('@pipeline-builder/api-server', {
  getContext: (req: any) => req.context,
  createProtectedRoute: () => [],
  withRoute: (handler: Function, options?: any) => async (req: any, res: any) => {
    const ctx = req.context;
    const orgId = ctx.identity.orgId?.toLowerCase() || '';
    const userId = ctx.identity.userId || '';
    const requireOrgId = options?.requireOrgId !== false;
    if (requireOrgId && !orgId) {
      return mockSendBadRequestForRoute(res, 'Organization ID is required');
    }
    try {
      await handler({ req, res, ctx, orgId, userId });
    } catch (error: any) {
      const msg = error instanceof Error ? error.message : String(error);
      return mockSendInternalErrorForRoute(res, msg);
    }
  },
}));

jest.unstable_mockModule('@pipeline-builder/pipeline-core', () => stubModule('@pipeline-builder/pipeline-core', {
  PluginType: {},
  ComputeType: {},
}));

const mockFindById = jest.fn<(...args: any[]) => any>();
const mockUpdate = jest.fn<(...args: any[]) => any>();
const mockVersionImmutability = jest.fn<(...args: any[]) => any>(async () => null);

jest.unstable_mockModule('../src/services/plugin-service.js', () => ({
  pluginService: {
    findById: mockFindById,
    update: mockUpdate,
    versionImmutability: mockVersionImmutability,
  },
}));

const mockOnPluginDeprecated = jest.fn<AnyFn>();
jest.unstable_mockModule('../src/helpers/deprecation-notice.js', () => ({ onPluginDeprecated: mockOnPluginDeprecated }));

const mockCheckUpdateCompliance = jest.fn<(...args: any[]) => any>(async () => ({ outcome: 'allowed' }));
jest.unstable_mockModule('../src/helpers/update-compliance.js', () => ({
  checkUpdateCompliance: mockCheckUpdateCompliance,
  needsComplianceRecheck: (data: Record<string, unknown>) => ['visibility', 'keywords', 'labels'].some((k) => k in data),
}));


// Imports (after mocks)

const { sendBadRequest, sendError, sendSuccess, requireVisibilityWriteAccess } = await import('@pipeline-builder/api-core');
const { createUpdatePluginRoutes } = await import('../src/routes/update-plugin.js');

// Helpers

const router = createUpdatePluginRoutes();

function getHandler(method: string, path: string) {
  const layer = (router as any).stack.find(
    (l: any) => l.route?.path === path && l.route?.methods[method],
  );
  if (!layer) throw new Error(`No handler for ${method.toUpperCase()} ${path}`);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

function mockReq(overrides: Record<string, unknown> = {}): any {
  return {
    params: { id: 'plugin-uuid-1' },
    query: {},
    body: {},
    headers: { authorization: 'Bearer tok' },
    context: {
      identity: { orgId: 'ORG-1', userId: 'user-1' },
      log: jest.fn<AnyFn>(),
      requestId: 'req-1',
    },
    ...overrides,
  };
}

function mockRes(): any {
  const res: any = {};
  res.status = jest.fn<AnyFn>().mockReturnValue(res);
  res.json = jest.fn<AnyFn>().mockReturnValue(res);
  return res;
}

const existingPlugin = {
  id: 'plugin-uuid-1',
  name: 'test-plugin',
  version: '1.0.0',
  orgId: 'org-1',
  visibility: 'private',
  isActive: true,
  isDefault: false,
};

// Tests

describe('PUT /plugins/:id (update)', () => {
  const handler = getHandler('put', '/:id');

  beforeEach(() => { jest.clearAllMocks(); });

  it('returns 200 and applies descriptive edits, recording their provenance as user', async () => {
    const updatedPlugin = { ...existingPlugin, description: 'updated description', category: 'security' };
    mockFindById.mockResolvedValue({ ...existingPlugin, metadataSources: { description: 'spec', license: 'spec' } });
    mockUpdate.mockResolvedValue(updatedPlugin);

    const req = mockReq({ body: { description: 'updated description', category: 'security', summary: 'One line.', homepageUrl: null } });
    const res = mockRes();
    await handler(req, res);

    expect(mockFindById).toHaveBeenCalledWith('plugin-uuid-1', 'org-1');
    expect(mockUpdate).toHaveBeenCalledWith(
      'plugin-uuid-1',
      {
        description: 'updated description',
        category: 'security',
        summary: 'One line.',
        homepageUrl: null,
        metadataSources: { description: 'user', license: 'spec', category: 'user', summary: 'user', homepageUrl: 'user' },
      },
      'org-1',
      'user-1',
      // Caller authority — promoting a default demotes the current one, which
      // the service gates on the visibility ladder.
      { isSystemAdmin: false, canPublish: false },
    );
    // Descriptive edits on a mutable version were checked for immutability first.
    expect(mockVersionImmutability).toHaveBeenCalled();
    // A descriptive-only edit doesn't change the compliance posture.
    expect(mockCheckUpdateCompliance).not.toHaveBeenCalled();
    // shapePlugin attaches the computed `uri` field to the response.
    expect(sendSuccess).toHaveBeenCalledWith(
      res,
      200,
      { plugin: expect.objectContaining({ ...updatedPlugin, uri: 'org-org-1/test-plugin:1.0.0' }) },
    );
  });

  it.each([
    [{ name: 'attempted-rename', version: '9.9.9' }, ['name', 'version']],
    [{ commands: ['rm -rf /'], env: { A: 'b' }, description: 'x' }, ['commands', 'env']],
    [{ computeType: 'LARGE', secrets: [], timeout: 5 }, ['secrets', 'computeType', 'timeout']],
  ])('refuses execution-contract keys %j with 400 naming them', async (body, keys) => {
    const res = mockRes();
    await handler(mockReq({ body }), res);

    expect(sendError).toHaveBeenCalledWith(res, 400, expect.stringContaining(keys.join(', ')), 'VALIDATION_ERROR', { fields: keys });
    expect(mockFindById).not.toHaveBeenCalled();
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('stores an edited README as source plus sanitized HTML', async () => {
    mockFindById.mockResolvedValue(existingPlugin);
    mockUpdate.mockResolvedValue(existingPlugin);

    await handler(mockReq({ body: { readme: '# Hi\n\n<script>alert(1)</script>ok' } }), mockRes());

    const data = mockUpdate.mock.calls[0]![1] as Record<string, unknown>;
    expect(data.readmeMd).toBe('# Hi\n\n<script>alert(1)</script>ok');
    expect(String(data.readmeHtml)).toContain('Hi');
    expect(String(data.readmeHtml)).not.toContain('<script>');
    expect(data.metadataSources).toEqual({ readme: 'user' });
  });

  it('clears category to unknown and keywords to none when set to null', async () => {
    mockFindById.mockResolvedValue(existingPlugin);
    mockUpdate.mockResolvedValue(existingPlugin);

    await handler(mockReq({ body: { category: null, keywords: null } }), mockRes());

    expect(mockUpdate.mock.calls[0]![1]).toEqual(expect.objectContaining({ category: 'unknown', keywords: [] }));
    // keywords feed the CIS inventory tags → compliance re-check.
    expect(mockCheckUpdateCompliance).toHaveBeenCalled();
  });

  it.each([['listed', /published to the ecosystem/], ['frozen', /publish request/]])(
    'refuses catalog edits on a %s version with 409', async (reason, message) => {
      mockFindById.mockResolvedValue(existingPlugin);
      mockVersionImmutability.mockResolvedValueOnce(reason);

      const res = mockRes();
      await handler(mockReq({ body: { summary: 'New.' } }), res);

      expect(sendError).toHaveBeenCalledWith(res, 409, expect.stringMatching(message), 'PLUGIN_VERSION_FROZEN');
      expect(mockUpdate).not.toHaveBeenCalled();
    },
  );

  it('refuses a VISIBILITY change on a frozen version — approval must still find it public', async () => {
    mockFindById.mockResolvedValue({ ...existingPlugin, visibility: 'public' });
    mockVersionImmutability.mockResolvedValueOnce('frozen');
    const res = mockRes();
    await handler(mockReq({ body: { visibility: 'org' } }), res);
    expect(sendError).toHaveBeenCalledWith(res, 409, expect.stringMatching(/visibility are frozen/), 'PLUGIN_VERSION_FROZEN');
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('lets operational flags change on a listed version (no catalog field touched)', async () => {
    mockFindById.mockResolvedValue(existingPlugin);
    mockUpdate.mockResolvedValue(existingPlugin);

    await handler(mockReq({ body: { isActive: false } }), mockRes());

    expect(mockVersionImmutability).not.toHaveBeenCalled();
    expect(mockUpdate).toHaveBeenCalledWith('plugin-uuid-1', { isActive: false }, 'org-1', 'user-1', expect.any(Object));
  });

  it('stamps deprecatedAt and announces the deprecation when lifecycle moves to deprecated', async () => {
    mockFindById.mockResolvedValue({ ...existingPlugin, deprecatedAt: null });
    mockUpdate.mockResolvedValue({ ...existingPlugin, lifecycle: 'deprecated' });

    await handler(mockReq({ body: { lifecycle: 'deprecated' } }), mockRes());

    expect(mockUpdate.mock.calls[0]![1]).toEqual({ lifecycle: 'deprecated', deprecatedAt: expect.any(Date) });
    expect(mockOnPluginDeprecated).toHaveBeenCalledTimes(1);
  });

  it('clears the deprecation when lifecycle moves off deprecated', async () => {
    mockFindById.mockResolvedValue({ ...existingPlugin, deprecatedAt: new Date(), lifecycle: 'deprecated' });
    mockUpdate.mockResolvedValue(existingPlugin);

    await handler(mockReq({ body: { lifecycle: 'production' } }), mockRes());

    expect(mockUpdate.mock.calls[0]![1]).toEqual({ lifecycle: 'production', deprecatedAt: null, deprecationMessage: null });
    expect(mockOnPluginDeprecated).not.toHaveBeenCalled();
  });

  it('refuses a lifecycle change on a yanked version', async () => {
    mockFindById.mockResolvedValue({ ...existingPlugin, lifecycle: 'yanked', yankedAt: new Date() });

    const res = mockRes();
    await handler(mockReq({ body: { lifecycle: 'production' } }), res);

    expect(sendError).toHaveBeenCalledWith(res, 409, expect.stringContaining('yanked'), 'CONFLICT');
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('blocks the update when the compliance re-check blocks it', async () => {
    mockFindById.mockResolvedValue(existingPlugin);
    mockCheckUpdateCompliance.mockResolvedValueOnce({ outcome: 'blocked', violations: [{ ruleId: 'r1' }] });

    const res = mockRes();
    await handler(mockReq({ body: { visibility: 'org' } }), res);

    expect(sendError).toHaveBeenCalledWith(res, 403, expect.any(String), 'COMPLIANCE_VIOLATION', { violations: [{ ruleId: 'r1' }] });
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('rejects the update when compliance is unavailable (fail-closed)', async () => {
    mockFindById.mockResolvedValue(existingPlugin);
    mockCheckUpdateCompliance.mockResolvedValueOnce({ outcome: 'unavailable', error: 'down' });

    const res = mockRes();
    await handler(mockReq({ body: { keywords: ['a'] } }), res);

    expect(sendError).toHaveBeenCalledWith(res, 503, expect.any(String), 'COMPLIANCE_SERVICE_UNAVAILABLE');
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('returns 400 when ID is missing', async () => {
    const req = mockReq({ params: {} });
    const res = mockRes();
    await handler(req, res);

    expect(sendBadRequest).toHaveBeenCalledWith(res, 'Plugin ID is required.', 'MISSING_REQUIRED_FIELD');
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it.each([
    [{ summary: 'x'.repeat(161) }],
    [{ license: 'WTFPL' }],
    [{ homepageUrl: 'http://acme.io' }],
    [{ category: 'build' }],
    [{ keywords: Array.from({ length: 11 }, (_, i) => `k${i}`) }],
    [{ notAField: true }],
  ])('returns 400 when the body fails the shared catalog validator: %j', async (body) => {
    const res = mockRes();
    await handler(mockReq({ body }), res);

    expect(sendBadRequest).toHaveBeenCalledWith(res, expect.any(String), 'VALIDATION_ERROR');
    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('returns 404 when plugin not found (findById returns null)', async () => {
    mockFindById.mockResolvedValue(null);

    const req = mockReq();
    const res = mockRes();
    await handler(req, res);

    expect(mockFindById).toHaveBeenCalledWith('plugin-uuid-1', 'org-1');
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: false,
      statusCode: 404,
      message: 'Plugin not found.',
    }));
  });

  it('returns 404 when update returns null', async () => {
    mockFindById.mockResolvedValue(existingPlugin);
    mockUpdate.mockResolvedValue(null);

    const req = mockReq({ body: { description: 'updated' } });
    const res = mockRes();
    await handler(req, res);

    expect(mockUpdate).toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: false,
      statusCode: 404,
      message: 'Plugin not found.',
    }));
  });

  it('returns 403 when requireVisibilityWriteAccess returns false', async () => {
    mockFindById.mockResolvedValue({ ...existingPlugin, visibility: 'public' });
    (requireVisibilityWriteAccess as jest.Mock<AnyFn>).mockReturnValueOnce(false);

    const req = mockReq();
    const res = mockRes();
    await handler(req, res);

    expect(requireVisibilityWriteAccess).toHaveBeenCalledWith(req, res, expect.objectContaining({ visibility: 'public' }), 'user-1', 'plugins:publish');
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('returns 500 on service error', async () => {
    mockFindById.mockRejectedValue(new Error('Database connection lost'));

    const req = mockReq();
    const res = mockRes();
    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: false,
      statusCode: 500,
      message: 'Database connection lost',
    }));
  });
});
