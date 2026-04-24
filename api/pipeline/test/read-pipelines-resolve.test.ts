// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * API integration tests for `GET /api/pipelines/:id?resolve=true`.
 *
 * Verifies that the route opts into pass-1 template resolution only when
 * the query param is set, returns source verbatim otherwise, and emits
 * a 400 with TEMPLATE_VALIDATION_FAILED on cycles / unknown paths.
 */

const mockFindById = jest.fn();

jest.mock('../src/services/pipeline-service', () => ({
  pipelineService: { findById: mockFindById },
}));

// api-core mock — only the symbols the route imports
jest.mock('@pipeline-builder/api-core', () => ({
  ErrorCode: {
    MISSING_REQUIRED_FIELD: 'MISSING_REQUIRED_FIELD',
    VALIDATION_ERROR: 'VALIDATION_ERROR',
    TEMPLATE_VALIDATION_FAILED: 'TEMPLATE_VALIDATION_FAILED',
  },
  getParam: (p: any, k: string) => p[k],
  requirePublicAccess: () => true,
  sendBadRequest: jest.fn((res: any, msg: string, code?: string) => {
    res.status(400).json({ success: false, statusCode: 400, message: msg, code });
  }),
  sendSuccess: jest.fn((res: any, statusCode: number, data?: any) => {
    res.status(statusCode).json({ success: true, statusCode, data });
  }),
  sendPaginatedNested: jest.fn(),
  sendEntityNotFound: jest.fn((res: any, entity: string) => {
    res.status(404).json({ success: false, message: `${entity} not found` });
  }),
  applyAccessControl: (f: any) => f,
  normalizeArrayFields: (x: any) => x,
  validateQuery: () => ({ ok: true, value: {} }),
  parsePaginationParams: () => ({ limit: 25, offset: 0 }),
  PipelineFilterSchema: {},
  incrementQuota: jest.fn(),
}));

jest.mock('@pipeline-builder/api-server', () => ({
  withRoute: (h: Function) => async (req: any, res: any) => {
    try { await h({ req, res, ctx: { log: jest.fn() }, orgId: 'org-1', userId: 'u-1' }); }
    catch (err: any) { res.status(500).json({ message: err.message }); }
  },
  incrementQuotaFromCtx: jest.fn(),
}));

jest.mock('@pipeline-builder/pipeline-core', () => ({
  CoreConstants: {
    CACHE_CONTROL_LIST: 'private, max-age=30',
    CACHE_CONTROL_DETAIL: 'private, max-age=60',
  },
  // These are used by pipeline-template-validator:
  validateTemplates: () => ({ valid: true, errors: [] }),
  detectCycles: () => [],
  allowedScopeRoots: () => () => true,
  resolveSelfReferencing: jest.fn((doc: Record<string, any>) => {
    // Simple substitution: walk metadata.* and replace {{ metadata.X }}
    const metadata = doc.metadata ?? {};
    const vars = doc.vars ?? {};
    const scope: Record<string, any> = { metadata, vars };
    const subst = (s: unknown) => {
      if (typeof s !== 'string') return s;
      return s.replace(/\{\{\s*(metadata|vars)\.([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g, (_, root, key) => {
        return String(scope[root]?.[key] ?? `{{ ${root}.${key} }}`);
      });
    };
    for (const k of Object.keys(metadata)) metadata[k] = subst(metadata[k]);
    return { errors: [] };
  }),
  tokenize: jest.fn(),
}));

import { createReadPipelineRoutes } from '../src/routes/read-pipelines';

const mockQuotaService = {
  increment: jest.fn().mockResolvedValue(undefined),
  check: jest.fn(),
  getUsage: jest.fn(),
} as any;

const router = createReadPipelineRoutes(mockQuotaService);

function getHandler(method: string, path: string) {
  const layer = (router as any).stack.find(
    (l: any) => l.route?.path === path && l.route?.methods[method],
  );
  return layer.route.stack[0].handle;
}

function mockReq(query: Record<string, string> = {}) {
  return { params: { id: 'pid-1' }, query, headers: { authorization: 'Bearer x' } } as any;
}
function mockRes() {
  const res: any = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  res.setHeader = jest.fn();
  return res;
}

describe('GET /pipelines/:id ?resolve=true', () => {
  const handler = getHandler('get', '/:id');

  beforeEach(() => jest.clearAllMocks());

  it('returns source (unresolved) when resolve is not set', async () => {
    mockFindById.mockResolvedValue({
      id: 'pid-1', accessModifier: 'public', pipelineName: 'p1',
      metadata: { env: 'prod', clusterName: 'acme-{{ metadata.env }}' },
      vars: {},
    });
    const res = mockRes();
    await handler(mockReq(), res);
    expect(res.status).toHaveBeenCalledWith(200);
    const payload = (res.json as jest.Mock).mock.calls[0][0];
    // Source form preserves template token intact
    expect(payload.data.pipeline.metadata.clusterName).toBe('acme-{{ metadata.env }}');
  });

  it('returns resolved form when resolve=true', async () => {
    mockFindById.mockResolvedValue({
      id: 'pid-1', accessModifier: 'public', pipelineName: 'p1',
      metadata: { env: 'prod', clusterName: 'acme-{{ metadata.env }}' },
      vars: {},
    });
    const res = mockRes();
    await handler(mockReq({ resolve: 'true' }), res);
    expect(res.status).toHaveBeenCalledWith(200);
    const payload = (res.json as jest.Mock).mock.calls[0][0];
    expect(payload.data.pipeline.metadata.clusterName).toBe('acme-prod');
  });

  it('returns source when resolve=false (any value other than "true")', async () => {
    mockFindById.mockResolvedValue({
      id: 'pid-1', accessModifier: 'public', pipelineName: 'p1',
      metadata: { env: 'prod', clusterName: 'acme-{{ metadata.env }}' },
    });
    const res = mockRes();
    await handler(mockReq({ resolve: 'false' }), res);
    const payload = (res.json as jest.Mock).mock.calls[0][0];
    expect(payload.data.pipeline.metadata.clusterName).toBe('acme-{{ metadata.env }}');
  });

  it('returns 400 TEMPLATE_VALIDATION_FAILED when resolution hits an error', async () => {
    // Swap the resolver mock to return an error once
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const core = require('@pipeline-builder/pipeline-core');
    (core.resolveSelfReferencing as jest.Mock).mockImplementationOnce(() => ({
      errors: [{ field: 'metadata.env', message: 'cycle detected', code: 'TEMPLATE_CYCLE' }],
    }));
    mockFindById.mockResolvedValue({
      id: 'pid-1', accessModifier: 'public', pipelineName: 'p1',
      metadata: { a: '{{ metadata.b }}', b: '{{ metadata.a }}' },
    });
    const res = mockRes();
    await handler(mockReq({ resolve: 'true' }), res);
    expect(res.status).toHaveBeenCalledWith(400);
    const payload = (res.json as jest.Mock).mock.calls[0][0];
    expect(payload.code).toBe('TEMPLATE_VALIDATION_FAILED');
  });
});
