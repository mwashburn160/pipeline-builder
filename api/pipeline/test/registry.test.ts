// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for POST /pipelines/registry endpoint.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

const mockInsert = jest.fn();
const mockOnConflictDoUpdate = jest.fn();
const mockReturning = jest.fn();
const mockSelect = jest.fn();
const mockDelete = jest.fn();

const mockEmitPipelineAudit = jest.fn();
jest.unstable_mockModule('../src/services/audit.js', () => ({
  emitPipelineAudit: mockEmitPipelineAudit,
  getAuditClient: () => ({ record: jest.fn() }),
}));

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  sendSuccess: jest.fn(),
  sendBadRequest: jest.fn(),
  sendError: jest.fn(),
  sendPaginatedNested: jest.fn(),
  getParam: (p: any, k: string) => p[k],
  parsePaginationParams: (_q: unknown) => ({ limit: 50, offset: 0 }),
  validateBody: (req: any, schema: any) => {
    const result = schema.safeParse(req.body);
    return result.success ? { ok: true, value: result.data } : { ok: false, error: result.error.message };
  },
  // Capability-aware gate so the RBAC tests exercise the real `requirePermission`
  // wiring on the write routes (403 without the capability, next() with it).
  requirePermission: (perm: string) => (req: any, res: any, next: () => void) => {
    const caps: string[] = req.user?.capabilities ?? [];
    return caps.includes(perm)
      ? next()
      : res.status(403).json({ success: false, statusCode: 403, message: `Missing ${perm}` });
  },
}));

jest.unstable_mockModule('@pipeline-builder/api-server', () => ({
  incCounter: () => undefined,
  checkQuota: () => (_req: any, _res: any, next: () => void) => next(),
  withRoute: (handler: any) => async (req: any, res: any) => {
    const ctx = { log: jest.fn(), identity: { orgId: 'acme', userId: 'user-1' }, requestId: 'req-1' };
    await handler({ req, res, ctx, orgId: 'acme', userId: 'user-1' });
  },
}));

jest.unstable_mockModule('@pipeline-builder/pipeline-data', () => ({
  // pipeline-registry-service was migrated to withTenantTx — hand the tx the
  // same spies registry.test.ts already tracks so existing assertions hold.
  withTenantTx: (fn: (tx: unknown) => unknown) => fn({
    insert: mockInsert,
    select: mockSelect,
    delete: mockDelete,
  }),
  schema: {
    pipelineRegistry: {
      pipelineId: 'pipeline_id',
      orgId: 'org_id',
      region: 'region',
      project: 'project',
      organization: 'organization',
      stackName: 'stack_name',
    },
    pipeline: {
      id: 'id',
      orgId: 'org_id',
    },
  },
}));

jest.unstable_mockModule('drizzle-orm', () => ({
  and: (...args: unknown[]) => ({ _kind: 'and', args }),
  eq: (col: unknown, val: unknown) => ({ _kind: 'eq', col, val }),
  desc: (col: unknown) => ({ _kind: 'desc', col }),
  // Capture the tagged-template SQL so tests can assert on COALESCE-style
  // conditional updates (e.g. region is preserved, not nulled, on partial re-register).
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({ _kind: 'sql', text: strings.join('?'), values }),
}));

const { sendSuccess, sendBadRequest, sendError, sendPaginatedNested } = await import('@pipeline-builder/api-core');
const { createRegistryRoutes } = await import('../src/routes/registry.js');

describe('POST /pipelines/registry', () => {
  let router: any;

  beforeEach(() => {
    jest.clearAllMocks();
    router = createRegistryRoutes();

    mockReturning.mockResolvedValue([{ id: 'reg-1', pipelineId: 'p-1' }]);
    mockOnConflictDoUpdate.mockReturnValue({ returning: mockReturning });
    mockInsert.mockReturnValue({
      values: jest.fn().mockReturnValue({
        onConflictDoUpdate: mockOnConflictDoUpdate,
      }),
    });

    // Default db.select chain: pipeline lookup returns a hit, registry lookup
    // returns no existing row (so the upsert proceeds to insert).
    let selectCallCount = 0;
    mockSelect.mockImplementation(() => ({
      from: jest.fn().mockImplementation(() => ({
        where: jest.fn().mockImplementation(() => {
          selectCallCount++;
          // Call 1 = pipeline tenancy lookup → return one row.
          // Call 2 = existing-registry lookup → return empty (new ARN).
          return Promise.resolve(selectCallCount === 1 ? [{ id: 'p-1' }] : []);
        }),
      })),
    }));

    // Default delete chain: delete().where().returning() → one removed row.
    mockDelete.mockReturnValue({
      where: jest.fn().mockReturnValue({
        returning: jest.fn().mockResolvedValue([{ id: 'reg-1', pipelineId: 'p-1' }]),
      }),
    });
  });

  function getHandler(method: 'post' | 'get' = 'post') {
    // The router has both GET and POST mounted at /registry; match by method.
    // Return the LAST layer in the route stack — the actual withRoute handler —
    // so the write routes' leading `requirePermission` middleware is skipped
    // when a test drives the handler directly.
    const stack = router.stack.find(
      (l: any) => l.route?.path === '/registry' && l.route?.methods?.[method],
    )?.route?.stack;
    return stack?.[stack.length - 1]?.handle;
  }

  // Runs the FULL route stack (gate middleware + handler) for a path/method so
  // the RBAC gate is exercised end-to-end.
  async function runStack(path: string, method: 'post' | 'delete', req: any, res: any) {
    const stack = router.stack.find(
      (l: any) => l.route?.path === path && l.route?.methods?.[method],
    )?.route?.stack;
    let i = 0;
    const next = async () => { if (i < stack.length) await stack[i++].handle(req, res, next); };
    await next();
  }

  it('should reject missing required fields', async () => {
    const handler = getHandler();
    const req = { body: { pipelineId: 'p-1' } }; // missing pipelineArn and pipelineName
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };

    await handler(req, res);

    expect(sendBadRequest).toHaveBeenCalled();
  });

  it('should upsert registry entry with valid data', async () => {
    const handler = getHandler();
    const req = {
      body: {
        pipelineId: 'p-1',
        pipelineArn: 'arn:aws:codepipeline:us-east-1:123:acme-pipeline',
        pipelineName: 'acme-pipeline',
        accountId: '123',
        region: 'us-east-1',
        project: 'webapp',
        organization: 'acme',
        stackName: 'webapp-acme',
      },
    };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };

    await handler(req, res);

    expect(mockInsert).toHaveBeenCalled();
    expect(sendSuccess).toHaveBeenCalled();
  });

  // FIX 4 — a partial re-register that omits `region` (and other optionals) must
  // NOT null out the stored value: execution routing resolves the CodePipeline
  // region from this row. The upsert conflict-set uses COALESCE(excluded.col,
  // table.col) so an absent incoming value keeps the existing one.
  it('preserves stored optional columns via COALESCE on partial re-register', async () => {
    const handler = getHandler('post');
    // No region/project/organization/stackName in this re-register.
    const req = { body: { pipelineId: 'p-1', pipelineName: 'acme-pipeline' } };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };

    await handler(req, res);

    expect(mockOnConflictDoUpdate).toHaveBeenCalledTimes(1);
    const set = (mockOnConflictDoUpdate.mock.calls[0][0] as any).set;

    // Optional columns are COALESCE expressions that fall back to the stored value.
    for (const col of ['region', 'project', 'organization']) {
      expect(set[col]).toEqual(expect.objectContaining({ _kind: 'sql' }));
      expect(set[col].text).toContain(`COALESCE(excluded.${col}`);
    }
    expect(set.stackName._kind).toBe('sql');
    expect(set.stackName.text).toContain('COALESCE(excluded.stack_name');

    // pipelineName is required and still written through unconditionally.
    expect(set.pipelineName).toBe('acme-pipeline');
  });

  // Tenancy guards added when the registry POST started accepting client
  // input. Without these, an org could claim another org's pipelineId by
  // guessing the UUID, OR overwrite the existing org-binding for an ARN.

  it('returns 404 when caller does not own the pipelineId', async () => {
    // Override default: pipeline lookup returns no rows (caller doesn't own it).
    mockSelect.mockImplementation(() => ({
      from: jest.fn().mockImplementation(() => ({
        where: jest.fn().mockResolvedValue([]),
      })),
    }));
    const handler = getHandler();
    const req = {
      body: {
        pipelineId: 'p-other-org',
        pipelineArn: 'arn:aws:codepipeline:us-east-1:123:other-pipeline',
        pipelineName: 'other-pipeline',
      },
    };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    await handler(req, res);

    expect(sendError).toHaveBeenCalledWith(
      res, 404, expect.stringMatching(/Pipeline not found/), expect.any(String),
    );
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it('returns 409 when ARN is already registered to a DIFFERENT org', async () => {
    // pipeline lookup hits, but existing-registry lookup returns a row owned
    // by another org → ARN is taken, refuse to overwrite the binding.
    let call = 0;
    mockSelect.mockImplementation(() => ({
      from: jest.fn().mockImplementation(() => ({
        where: jest.fn().mockImplementation(() => {
          call++;
          if (call === 1) return Promise.resolve([{ id: 'p-1' }]);
          return Promise.resolve([{ orgId: 'OTHER-org' }]);
        }),
      })),
    }));

    const handler = getHandler();
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    await handler({
      body: {
        pipelineId: 'p-1',
        pipelineArn: 'arn:aws:codepipeline:us-east-1:123:pipe',
        pipelineName: 'pipe',
      },
    }, res);

    expect(sendError).toHaveBeenCalledWith(
      res, 409, expect.stringContaining('different organization'), expect.any(String),
    );
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it('GET /registry returns paginated list scoped to caller org', async () => {
    // db.select for the count query (returns [{count:1}]), then for the rows query
    let callCount = 0;
    mockSelect.mockImplementation(() => ({
      from: jest.fn().mockImplementation(() => ({
        where: jest.fn().mockImplementation(() => {
          callCount++;
          if (callCount === 1) return Promise.resolve([{ count: 1 }]);
          // The list query has additional .orderBy/.limit/.offset chained
          return {
            orderBy: jest.fn().mockReturnValue({
              limit: jest.fn().mockReturnValue({
                offset: jest.fn().mockResolvedValue([
                  { id: 'reg-1', pipelineId: 'p-1', pipelineName: 'demo', lastDeployed: new Date() },
                ]),
              }),
            }),
          };
        }),
      })),
    }));

    const handler = getHandler('get');
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    await handler({ query: {} }, res);

    expect(sendPaginatedNested).toHaveBeenCalledWith(
      res, 'registry',
      expect.arrayContaining([expect.objectContaining({ id: 'reg-1' })]),
      expect.objectContaining({ total: 1 }),
    );
  });

  // RBAC gate (#FIX 1): POST/DELETE on the pipeline ARN-registry are writes and
  // must sit behind `requirePermission('pipelines:write')`. A pipelines:read-only
  // member is rejected with 403 before the handler runs; the GET stays ungated.
  describe('pipelines:write gate on registry writes', () => {
    const body = { pipelineId: 'p-1', pipelineName: 'acme-pipeline' };

    it('POST /registry → 403 without pipelines:write (no upsert)', async () => {
      const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
      await runStack('/registry', 'post', { body, user: { capabilities: ['pipelines:read'] } }, res);
      expect(res.status).toHaveBeenCalledWith(403);
      expect(mockInsert).not.toHaveBeenCalled();
    });

    it('POST /registry → allowed with pipelines:write (upserts)', async () => {
      const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
      await runStack('/registry', 'post', { body, user: { capabilities: ['pipelines:write'] } }, res);
      expect(mockInsert).toHaveBeenCalled();
      expect(sendSuccess).toHaveBeenCalled();
    });

    it('DELETE /registry/:id → 403 without pipelines:write (no delete)', async () => {
      const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
      await runStack('/registry/:id', 'delete', { params: { id: 'reg-1' }, user: { capabilities: ['pipelines:read'] } }, res);
      expect(res.status).toHaveBeenCalledWith(403);
    });
  });

  // Attributed audit emissions on the registry write routes. `targetId` must be
  // the stable pipeline id, and — critically — `details` must never carry the
  // CodePipeline ARN (which embeds the AWS account id).
  describe('registry audit emissions', () => {
    /** Deep-scan any value for an ARN or a 12-digit AWS account id. */
    function containsArnOrAccountId(value: unknown): boolean {
      const hay = JSON.stringify(value ?? {});
      return /arn:aws/i.test(hay) || /\b\d{12}\b/.test(hay);
    }

    it('POST /registry emits pipeline.registry.register with targetId=pipelineId and NO ARN/account in details', async () => {
      const handler = getHandler('post');
      const req = {
        body: {
          pipelineId: 'p-1',
          // These are NOT part of PipelineRegistrySchema and must never surface
          // in the audit details even when a client sends them.
          pipelineArn: 'arn:aws:codepipeline:us-east-1:123456789012:acme-pipeline',
          accountId: '123456789012',
          pipelineName: 'acme-pipeline',
          region: 'us-east-1',
          project: 'webapp',
          organization: 'acme',
          stackName: 'webapp-acme',
        },
      };
      const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
      await handler(req, res);

      expect(mockEmitPipelineAudit).toHaveBeenCalledTimes(1);
      const event: any = mockEmitPipelineAudit.mock.calls[0][0];
      expect(event).toEqual(
        expect.objectContaining({
          action: 'pipeline.registry.register',
          actorId: 'user-1',
          orgId: 'acme',
          targetType: 'pipeline',
          targetId: 'p-1',
        }),
      );
      // Hard rule: no ARN and no AWS account id anywhere in details.
      expect(containsArnOrAccountId(event.details)).toBe(false);
      expect(event.details).not.toHaveProperty('pipelineArn');
      expect(event.details).not.toHaveProperty('accountId');
    });

    it('POST /registry does NOT emit when the upsert is rejected (pipeline not owned)', async () => {
      mockSelect.mockImplementation(() => ({
        from: jest.fn().mockImplementation(() => ({
          where: jest.fn().mockResolvedValue([]),
        })),
      }));
      const handler = getHandler('post');
      const req = { body: { pipelineId: 'p-x', pipelineName: 'x' } };
      const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
      await handler(req, res);

      expect(mockEmitPipelineAudit).not.toHaveBeenCalled();
    });

    it('DELETE /registry/:id emits pipeline.registry.deregister with targetId=pipelineId and no ARN/account', async () => {
      const handler = router.stack.find(
        (l: any) => l.route?.path === '/registry/:id' && l.route?.methods?.delete,
      )?.route?.stack;
      const deleteHandler = handler[handler.length - 1].handle;

      const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
      await deleteHandler({ params: { id: 'reg-1' } }, res);

      expect(mockEmitPipelineAudit).toHaveBeenCalledTimes(1);
      const event: any = mockEmitPipelineAudit.mock.calls[0][0];
      expect(event).toEqual(
        expect.objectContaining({
          action: 'pipeline.registry.deregister',
          actorId: 'user-1',
          orgId: 'acme',
          targetType: 'pipeline',
          targetId: 'p-1',
        }),
      );
      expect(containsArnOrAccountId(event.details)).toBe(false);
    });

    it('DELETE /registry/:id does NOT emit when the row is absent (404)', async () => {
      mockDelete.mockReturnValue({
        where: jest.fn().mockReturnValue({
          returning: jest.fn().mockResolvedValue([]),
        }),
      });
      const handler = router.stack.find(
        (l: any) => l.route?.path === '/registry/:id' && l.route?.methods?.delete,
      )?.route?.stack;
      const deleteHandler = handler[handler.length - 1].handle;

      const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
      await deleteHandler({ params: { id: 'missing' } }, res);

      expect(mockEmitPipelineAudit).not.toHaveBeenCalled();
    });
  });
});
