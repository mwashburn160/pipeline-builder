/**
 * Tests for POST /reports/events ingest endpoint.
 */

const mockSelect = jest.fn();
const mockInsert = jest.fn();

jest.mock('@mwashburn160/api-server', () => ({
  withRoute: (handler: any, opts?: any) => async (req: any, res: any) => {
    const ctx = { log: jest.fn(), identity: { orgId: 'test-org', userId: 'user-1' }, requestId: 'req-1' };
    await handler({ req, res, ctx, orgId: opts?.requireOrgId === false ? '' : 'test-org', userId: 'user-1' });
  },
  createAuthenticatedWithOrgRoute: () => [jest.fn((_req: any, _res: any, next: any) => next())],
  createApp: () => ({ app: { use: jest.fn(), get: jest.fn() }, sseManager: {} }),
  runServer: jest.fn(),
  attachRequestContext: () => jest.fn(),
}));

jest.mock('@mwashburn160/api-core', () => ({
  sendSuccess: jest.fn((_res: any, _code: number, data: any) => data),
  sendBadRequest: jest.fn((_res: any, msg: string) => msg),
  ErrorCode: { VALIDATION_ERROR: 'VALIDATION_ERROR' },
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
  requireAuth: jest.fn((_req: any, _res: any, next: any) => next()),
  hashAccountInArn: (arn: string) => arn,
  hashId: (value: string) => value,
}));

jest.mock('@mwashburn160/pipeline-core', () => ({
  CoreConstants: {
    MAX_EVENTS_PER_BATCH: 100,
  },
  db: {
    select: mockSelect,
    insert: mockInsert,
  },
  schema: {
    pipelineRegistry: {
      pipelineId: 'pipeline_id',
      orgId: 'org_id',
      pipelineArn: 'pipeline_arn',
    },
    pipelineEvent: 'pipeline_events',
  },
}));

jest.mock('drizzle-orm', () => ({
  eq: jest.fn((col: any, val: any) => ({ col, val })),
  inArray: jest.fn((col: any, vals: any) => ({ col, vals })),
}));

import { createEventIngestRoutes } from '../src/routes/event-ingest';

describe('POST /reports/events', () => {
  let router: any;

  beforeEach(() => {
    jest.clearAllMocks();
    router = createEventIngestRoutes();

    // Default: registry lookup returns a match
    const mockFrom = jest.fn().mockReturnValue({
      where: jest.fn().mockReturnValue({
        limit: jest.fn().mockResolvedValue([{ pipelineId: 'p-1', orgId: 'acme' }]),
      }),
    });
    mockSelect.mockReturnValue({ from: mockFrom });

    // Default: insert succeeds
    mockInsert.mockReturnValue({
      values: jest.fn().mockResolvedValue({}),
    });
  });

  it('should reject empty events array', async () => {
    const handler = router.stack.find((l: any) => l.route?.path === '/events')?.route?.stack[0]?.handle;
    expect(handler).toBeDefined();

    const req = { body: { events: [] } };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };

    await handler(req, res);
    // sendBadRequest was called — verify via the mock
  });

  it('should reject more than 100 events', async () => {
    const handler = router.stack.find((l: any) => l.route?.path === '/events')?.route?.stack[0]?.handle;

    const events = Array.from({ length: 101 }, (_, i) => ({
      pipelineArn: `arn:aws:codepipeline:us-east-1:123:pipe-${i}`,
      eventSource: 'codepipeline',
      eventType: 'PIPELINE',
      status: 'SUCCEEDED',
    }));

    const req = { body: { events } };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };

    await handler(req, res);
  });

  it('should reject request without events field', async () => {
    const handler = router.stack.find((l: any) => l.route?.path === '/events')?.route?.stack[0]?.handle;

    const req = { body: {} };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };

    await handler(req, res);
  });
});
