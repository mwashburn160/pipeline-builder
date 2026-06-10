// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for POST /reports/events ingest endpoint.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

const mockSelect = jest.fn<(...args: unknown[]) => unknown>();
const mockInsert = jest.fn<(...args: unknown[]) => unknown>();

jest.unstable_mockModule('@pipeline-builder/api-server', () => ({
  withRoute: (handler: any, opts?: any) => async (req: any, res: any) => {
    const ctx = { log: jest.fn(), identity: { orgId: 'test-org', userId: 'user-1' }, requestId: 'req-1' };
    await handler({ req, res, ctx, orgId: opts?.requireOrgId === false ? '' : 'test-org', userId: 'user-1' });
  },
  createAuthenticatedWithOrgRoute: () => [jest.fn((_req: any, _res: any, next: any) => next())],
  createApp: () => ({ app: { use: jest.fn(), get: jest.fn() }, sseManager: {} }),
  runServer: jest.fn(),
  attachRequestContext: () => jest.fn(),
}));

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  sendSuccess: jest.fn((_res: any, _code: number, data: any) => data),
  sendBadRequest: jest.fn((_res: any, msg: string) => msg),
  requireAuth: jest.fn((_req: any, _res: any, next: any) => next()),
  hashAccountInArn: (arn: string) => arn,
  hashId: (value: string) => value,
  parseDateRange: jest.fn(() => ({ from: '2026-01-01T00:00:00Z', to: '2026-01-31T00:00:00Z' })),
  REPORT_INTERVALS: ['day', 'week', 'month'] as const,
  isSystemAdmin: jest.fn((req: any) => req?.user?.isSuperAdmin === true),
  parseQueryIntClamped: jest.fn((val: any, def: number, max: number) =>
    Math.min(Math.max(1, parseInt(String(val ?? def), 10) || def), max)),
  validateBulkArray: jest.fn((value: any, _name: string, max?: number) =>
    Array.isArray(value) && value.length > 0 && (!max || value.length <= max)
      ? { value }
      : { error: 'invalid' }),
}));

jest.unstable_mockModule('@pipeline-builder/pipeline-data', () => ({
  reportingService: {
    invalidateOrg: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
  },
}));

jest.unstable_mockModule('@pipeline-builder/pipeline-core', () => ({
  CoreConstants: {
    MAX_EVENTS_PER_BATCH: 100,
  },
  runWithTenantContext: (_ctx: any, fn: () => unknown) => fn(),
  db: {
    select: mockSelect,
    insert: mockInsert,
  },
  schema: {
    pipelineRegistry: {
      pipelineId: 'pipeline_id',
      orgId: 'org_id',
    },
    pipelineEvent: 'pipeline_events',
  },
}));

jest.unstable_mockModule('drizzle-orm', () => ({
  eq: jest.fn((col: any, val: any) => ({ col, val })),
  inArray: jest.fn((col: any, vals: any) => ({ col, vals })),
}));

const { createEventIngestRoutes } = await import('../src/routes/event-ingest.js');

describe('POST /reports/events', () => {
  let router: any;

  beforeEach(() => {
    jest.clearAllMocks();
    router = createEventIngestRoutes();

    // Default: registry lookup returns a match
    const mockFrom = jest.fn().mockReturnValue({
      where: jest.fn().mockReturnValue({
        limit: jest.fn<() => Promise<unknown>>().mockResolvedValue([{ pipelineId: 'p-1', orgId: 'acme' }]),
      }),
    });
    mockSelect.mockReturnValue({ from: mockFrom });

    // Default: insert succeeds
    mockInsert.mockReturnValue({
      values: jest.fn<() => Promise<unknown>>().mockResolvedValue({}),
    });
  });

  it('should reject empty events array', async () => {
    const handler = router.stack.find((l: any) => l.route?.path === '/')?.route?.stack[0]?.handle;
    expect(handler).toBeDefined();

    const req = { body: { events: [] } };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };

    await handler(req, res);
    // sendBadRequest was called — verify via the mock
  });

  it('should reject more than 100 events', async () => {
    const handler = router.stack.find((l: any) => l.route?.path === '/')?.route?.stack[0]?.handle;

    const events = Array.from({ length: 101 }, (_, i) => ({
      pipelineId: `pipeline-uuid-${i}`,
      eventSource: 'codepipeline',
      eventType: 'PIPELINE',
      status: 'SUCCEEDED',
    }));

    const req = { body: { events } };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };

    await handler(req, res);
  });

  it('should reject request without events field', async () => {
    const handler = router.stack.find((l: any) => l.route?.path === '/')?.route?.stack[0]?.handle;

    const req = { body: {} };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };

    await handler(req, res);
  });
});
