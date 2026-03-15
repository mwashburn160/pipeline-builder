/**
 * Tests for POST /pipelines/registry endpoint.
 */

const mockInsert = jest.fn();
const mockOnConflictDoUpdate = jest.fn();
const mockReturning = jest.fn();

jest.mock('@mwashburn160/api-core', () => ({
  sendSuccess: jest.fn(),
  sendBadRequest: jest.fn(),
  ErrorCode: { VALIDATION_ERROR: 'VALIDATION_ERROR' },
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
  hashAccountInArn: (arn: string) => arn, // pass-through in tests
  hashId: (value: string) => value,       // pass-through in tests
}));

jest.mock('@mwashburn160/api-server', () => ({
  withRoute: (handler: any) => async (req: any, res: any) => {
    const ctx = { log: jest.fn(), identity: { orgId: 'acme', userId: 'user-1' }, requestId: 'req-1' };
    await handler({ req, res, ctx, orgId: 'acme', userId: 'user-1' });
  },
}));

jest.mock('@mwashburn160/pipeline-core', () => ({
  db: {
    insert: mockInsert,
  },
  schema: {
    pipelineRegistry: {
      pipelineArn: 'pipeline_arn',
    },
  },
}));

import { createRegistryRoutes } from '../src/routes/registry';
import { sendSuccess, sendBadRequest } from '@mwashburn160/api-core';

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
  });

  function getHandler() {
    return router.stack.find((l: any) => l.route?.path === '/registry')?.route?.stack[0]?.handle;
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
});
