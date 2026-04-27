// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for POST /pipelines/registry endpoint.
 */

const mockInsert = jest.fn();
const mockOnConflictDoUpdate = jest.fn();
const mockReturning = jest.fn();
const mockSelect = jest.fn();

jest.mock('@pipeline-builder/api-core', () => ({
  sendSuccess: jest.fn(),
  sendBadRequest: jest.fn(),
  sendError: jest.fn(),
  sendPaginatedNested: jest.fn(),
  ErrorCode: { VALIDATION_ERROR: 'VALIDATION_ERROR', NOT_FOUND: 'NOT_FOUND', CONFLICT: 'CONFLICT' },
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
  hashAccountInArn: (arn: string) => arn, // pass-through in tests
  hashId: (value: string) => value, // pass-through in tests
  parsePaginationParams: (_q: unknown) => ({ limit: 50, offset: 0 }),
  validateBody: (req: any, schema: any) => {
    const result = schema.safeParse(req.body);
    return result.success ? { ok: true, value: result.data } : { ok: false, error: result.error.message };
  },
}));

jest.mock('@pipeline-builder/api-server', () => ({
  withRoute: (handler: any) => async (req: any, res: any) => {
    const ctx = { log: jest.fn(), identity: { orgId: 'acme', userId: 'user-1' }, requestId: 'req-1' };
    await handler({ req, res, ctx, orgId: 'acme', userId: 'user-1' });
  },
}));

jest.mock('@pipeline-builder/pipeline-core', () => ({
  db: {
    insert: mockInsert,
    select: mockSelect,
  },
  schema: {
    pipelineRegistry: {
      pipelineArn: 'pipeline_arn',
      orgId: 'org_id',
    },
    pipeline: {
      id: 'id',
      orgId: 'org_id',
    },
  },
}));

jest.mock('drizzle-orm', () => ({
  and: (...args: unknown[]) => ({ _kind: 'and', args }),
  eq: (col: unknown, val: unknown) => ({ _kind: 'eq', col, val }),
  desc: (col: unknown) => ({ _kind: 'desc', col }),
  sql: jest.fn(),
}));

import { sendSuccess, sendBadRequest, sendError, sendPaginatedNested } from '@pipeline-builder/api-core';
import { createRegistryRoutes } from '../src/routes/registry';

describe('POST /pipelines/registry', () => {
  let router: any;

  beforeEach(() => {
    jest.clearAllMocks();
    router = createRegistryRoutes();

    mockReturning.mockResolvedValue([{ id: 'reg-1', pipelineArn: 'arn:aws:codepipeline:us-east-1:123:acme-pipeline' }]);
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
  });

  function getHandler(method: 'post' | 'get' = 'post') {
    // The router has both GET and POST mounted at /registry; match by method.
    return router.stack.find(
      (l: any) => l.route?.path === '/registry' && l.route?.methods?.[method],
    )?.route?.stack[0]?.handle;
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
});
