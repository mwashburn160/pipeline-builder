// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for POST /reports/events ingest endpoint.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import type { AnyFn } from '@pipeline-builder/api-core/testing';
import { stubModule } from '@pipeline-builder/api-core/testing';
import { apiCoreMock } from './helpers/mock-api-core.js';
import { routeChain } from './helpers/route-chain.js';

const mockSelect = jest.fn<(...args: unknown[]) => unknown>();
const mockInsert = jest.fn<(...args: unknown[]) => unknown>();
const mockSendError = jest.fn((_res: any, code: number, msg: string, ..._rest: unknown[]) => ({ error: msg, code }));
const mockSendBadRequest = jest.fn((_res: any, msg: string, _code?: string) => msg);
const mockSendSuccess = jest.fn((_res: any, _code: number, data: any) => data);

jest.unstable_mockModule('@pipeline-builder/api-server', () => stubModule('@pipeline-builder/api-server', {
  withRoute: (handler: any, opts?: any) => async (req: any, res: any) => {
    const ctx = { log: jest.fn<AnyFn>(), identity: { orgId: 'test-org', userId: 'user-1' }, requestId: 'req-1' };
    await handler({ req, res, ctx, orgId: opts?.requireOrgId === false ? '' : 'test-org', userId: 'user-1' });
  },
  createAuthenticatedWithOrgRoute: () => [jest.fn((_req: any, _res: any, next: any) => next())],
  createApp: () => ({ app: { use: jest.fn<AnyFn>(), get: jest.fn<AnyFn>() }, sseManager: {} }),
  runServer: jest.fn<AnyFn>(),
  attachRequestContext: () => jest.fn<AnyFn>(),
  incCounter: (...a: unknown[]) => mockIncCounter(...a),
}));

const mockIncCounter = jest.fn<(...a: unknown[]) => void>();

// WHO the caller is, for the ingest tenancy check. The real events Lambda holds a
// signed service key, so the default fixture is a verified service principal —
// which is also what keeps these metric/SSE tests about the route's own behaviour
// rather than about org resolution (that has its own tests below).
const mockVerifyServicePrincipal = jest.fn<(req: unknown) => boolean>().mockReturnValue(true);
const mockResolveOrgRollup = jest.fn<(orgId: string) => Promise<string[] | undefined>>();

jest.unstable_mockModule('../src/helpers/report-helpers.js', () => ({
  resolveOrgRollup: (orgId: string) => mockResolveOrgRollup(orgId),
}));

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  sendSuccess: mockSendSuccess,
  sendBadRequest: mockSendBadRequest,
  sendError: mockSendError,
  requireAuth: jest.fn((_req: any, _res: any, next: any) => next()),
  hasScope: (req: any, scope: string) => req?.user?.scope === scope,
  verifyServicePrincipal: (req: any) => mockVerifyServicePrincipal(req),
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

const mockSseSend = jest.fn<AnyFn>();
const mockLastDeployedCommit = jest.fn<AnyFn>()
  .mockResolvedValue({ commitSha: 'abc123', deployedAt: '2026-03-01T00:00:00Z' });
const mockIngestEvents = jest.fn<AnyFn>()
  .mockResolvedValue({ inserted: 1, skipped: 0, unregisteredPipelineIds: [], affectedOrgs: ['acme'] });
jest.unstable_mockModule('@pipeline-builder/pipeline-data', () => stubModule('@pipeline-builder/pipeline-data', {
  reportingService: {
    invalidateOrg: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    ingestEvents: (...a: unknown[]) => mockIngestEvents(...a),
    getLastDeployedCommit: (...a: unknown[]) => mockLastDeployedCommit(...a),
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

jest.unstable_mockModule('@pipeline-builder/pipeline-core', () => stubModule('@pipeline-builder/pipeline-core', {
  CoreConstants: {
    MAX_EVENTS_PER_BATCH: 100,
  },
}));

const { createEventIngestRoutes } = await import('../src/routes/event-ingest.js');

describe('POST /reports/events', () => {
  let router: any;

  beforeEach(() => {
    jest.clearAllMocks();
    mockVerifyServicePrincipal.mockReturnValue(true);
    mockResolveOrgRollup.mockResolvedValue(undefined);
    // A real send spy: the live-execution fan-out is a behaviour of this route,
    // and it was passing an empty manager that swallowed everything.
    router = createEventIngestRoutes({ send: mockSseSend } as never);

    // Default: registry lookup returns a match
    const mockFrom = jest.fn<AnyFn>().mockReturnValue({
      where: jest.fn<AnyFn>().mockReturnValue({
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
    const handler = routeChain(router, '/');
    expect(handler).toBeDefined();

    const req = ingestReq({ body: { events: [] } });
    const res = { status: jest.fn<AnyFn>().mockReturnThis(), json: jest.fn<AnyFn>() };

    await handler(req, res);

    // Empty array fails the schema's `.min(1)` — must be rejected as a 400
    // VALIDATION_ERROR and must never reach the DB insert / ingest path.
    expect(mockSendBadRequest).toHaveBeenCalledWith(
      expect.anything(), expect.any(String), 'VALIDATION_ERROR');
    expect(mockIngestEvents).not.toHaveBeenCalled();
    expect(mockSendSuccess).not.toHaveBeenCalled();
  });

  it('should reject more than 100 events', async () => {
    const handler = routeChain(router, '/');

    const events = Array.from({ length: 101 }, (_, i) => ({
      pipelineId: `pipeline-uuid-${i}`,
      eventSource: 'codepipeline',
      eventType: 'PIPELINE',
      status: 'SUCCEEDED',
    }));

    expect(events).toHaveLength(101); // guard: must actually exceed MAX_EVENTS_PER_BATCH (100)

    const req = ingestReq({ body: { events } });
    const res = { status: jest.fn<AnyFn>().mockReturnThis(), json: jest.fn<AnyFn>() };

    await handler(req, res);

    // 101 valid events pass per-item schema but trip the batch-size cap — must
    // be rejected as a 400 VALIDATION_ERROR naming the limit, never ingested.
    expect(mockSendBadRequest).toHaveBeenCalledWith(
      expect.anything(), expect.stringContaining('Maximum 100'), 'VALIDATION_ERROR');
    expect(mockIngestEvents).not.toHaveBeenCalled();
    expect(mockSendSuccess).not.toHaveBeenCalled();
  });

  it('should reject request without events field', async () => {
    const handler = routeChain(router, '/');

    const req = ingestReq({ body: {} });
    const res = { status: jest.fn<AnyFn>().mockReturnThis(), json: jest.fn<AnyFn>() };

    await handler(req, res);

    // Missing `events` field fails the required-array schema — must be rejected
    // as a 400 VALIDATION_ERROR and must not reach the ingest path.
    expect(mockSendBadRequest).toHaveBeenCalledWith(
      expect.anything(), expect.any(String), 'VALIDATION_ERROR');
    expect(mockIngestEvents).not.toHaveBeenCalled();
    expect(mockSendSuccess).not.toHaveBeenCalled();
  });

  // --- reporting:ingest scope guard -------------------------------------------

  const validEvent = { pipelineId: 'p-1', eventSource: 'codepipeline', eventType: 'PIPELINE', status: 'SUCCEEDED' };
  /**
   * A request shaped like the real one. `headers` matters: the ingest tenancy check
   * calls `verifyServicePrincipal`, which reads `req.headers.authorization` — a bare
   * `{ body, user }` fixture made the route throw before it ran.
   */
  const ingestReq = (over: Record<string, unknown> = {}) => ({
    headers: {},
    body: { events: [validEvent] },
    user: { sub: 'svc', scope: 'reporting:ingest' },
    ...over,
  });
  const getHandler = () => routeChain(router, '/');
  const res = () => ({ status: jest.fn<AnyFn>().mockReturnThis(), json: jest.fn<AnyFn>() });

  it('rejects a non-scoped token with 403 (scope is always enforced)', async () => {
    await getHandler()(ingestReq({ user: { sub: 'u-1' } }), res());
    expect(mockSendError).toHaveBeenCalledWith(expect.anything(), 403, expect.stringContaining('reporting:ingest'), expect.anything());
    expect(mockIngestEvents).not.toHaveBeenCalled();
  });

  it('accepts a reporting:ingest-scoped token', async () => {
    await getHandler()(ingestReq(), res());
    expect(mockSendError).not.toHaveBeenCalled();
    expect(mockIngestEvents).toHaveBeenCalled();
  });

  // The route passes an onMetric hook into ingestEvents that fans each
  // registered terminal deploy/stage outcome into Prometheus counters.
  it('fans a terminal deploy-stage metric into pipeline_stage_result_total + pipeline_deploy_result_total', async () => {
    mockIngestEvents.mockImplementationOnce(async (_events: unknown, onMetric: (m: unknown) => void) => {
      onMetric({ pipelineId: 'p-1', orgId: 'acme', stage: 'Deploy-prod', environment: 'production', result: 'succeeded' });
      return { inserted: 1, skipped: 0, unregisteredPipelineIds: [], affectedOrgs: ['acme'] };
    });

    await getHandler()(ingestReq(), res());

    expect(mockIncCounter).toHaveBeenCalledWith('pipeline_stage_result_total',
      { pipeline_id: 'p-1', stage: 'Deploy-prod', environment: 'production', org_id: 'acme', result: 'succeeded' });
    expect(mockIncCounter).toHaveBeenCalledWith('pipeline_deploy_result_total',
      { environment: 'production', org_id: 'acme', result: 'succeeded' });
  });

  it('does NOT emit the deploy counter for a non-deploy stage metric (no environment)', async () => {
    mockIngestEvents.mockImplementationOnce(async (_events: unknown, onMetric: (m: unknown) => void) => {
      onMetric({ pipelineId: 'p-1', orgId: 'acme', stage: 'Build', environment: null, result: 'failed' });
      return { inserted: 1, skipped: 0, unregisteredPipelineIds: [], affectedOrgs: ['acme'] };
    });

    await getHandler()(ingestReq(), res());

    expect(mockIncCounter).toHaveBeenCalledWith('pipeline_stage_result_total', expect.objectContaining({ result: 'failed', environment: '' }));
    expect(mockIncCounter).not.toHaveBeenCalledWith('pipeline_deploy_result_total', expect.anything());
  });
  /**
   * The live execution channel. The fan-out used to be driven off the
   * stage-metric hook, which only fires for STAGE events — so a batch of
   * PIPELINE or BUILD events landed rows and pushed NO frame, and the dashboard
   * quietly fell back to manual refresh for exactly the events an execution view
   * exists to show. It is driven off `affectedOrgs` (every org with a row in the
   * batch) instead.
   */
  describe('live execution SSE', () => {
    it('pushes a frame for a batch that produced no stage metric at all', async () => {
      mockIngestEvents.mockImplementationOnce(async () =>
        // No onMetric call: a PIPELINE/BUILD-only batch.
        ({ inserted: 2, skipped: 0, unregisteredPipelineIds: [], affectedOrgs: ['acme'] }));

      await getHandler()(ingestReq(), res());

      expect(mockSseSend).toHaveBeenCalledWith('acme', 'MESSAGE', 'execution-updated', expect.any(Object));
    });

    it('sends one frame per affected org, not one per event', async () => {
      mockIngestEvents.mockImplementationOnce(async () =>
        ({ inserted: 50, skipped: 0, unregisteredPipelineIds: [], affectedOrgs: ['acme', 'globex'] }));

      await getHandler()(ingestReq(), res());

      expect(mockSseSend).toHaveBeenCalledTimes(2);
    });

    it('stays silent when nothing landed', async () => {
      mockIngestEvents.mockImplementationOnce(async () =>
        ({ inserted: 0, skipped: 1, unregisteredPipelineIds: ['p-x'], affectedOrgs: [] }));

      await getHandler()(ingestReq(), res());

      expect(mockSseSend).not.toHaveBeenCalled();
    });
  });

  /**
   * WHICH ORGS THE CALLER MAY WRITE FOR. An event's org comes from the pipeline
   * REGISTRY, not the token, so the `reporting:ingest` scope alone let any holder
   * post events for another org's pipeline id and have them attributed there. The
   * route resolves the allowed set and hands it to `ingestEvents`, which drops the
   * rest — so what is asserted here is the SET the route computes.
   */
  describe('caller org scope', () => {
    const callerArg = () => (mockIngestEvents.mock.calls.at(-1) as unknown[])[2];

    it('lets a verified internal service write cross-tenant', async () => {
      // The plugin service posts plugin-build events for every tenant and holds a
      // signed service key no external client can mint.
      await getHandler()(ingestReq(), res());
      expect(callerArg()).toEqual({ allowedOrgIds: [], crossTenant: true });
    });

    it('confines a normal caller to its own org and descendant teams', async () => {
      mockVerifyServicePrincipal.mockReturnValue(false);
      mockResolveOrgRollup.mockResolvedValue(['parent-org', 'team-a']);
      await getHandler()(ingestReq({ user: { sub: 'u-1', scope: 'reporting:ingest', organizationId: 'parent-org' } }), res());
      expect(callerArg()).toEqual({ allowedOrgIds: ['parent-org', 'team-a'] });
    });

    it('NARROWS to the caller org when the rollup cannot be resolved', async () => {
      // resolveOrgRollup is fail-soft (undefined on any error), which is the wrong
      // direction for a tenancy boundary: an unreachable platform must never widen
      // the set. A parent loses its teams' events during that outage rather than
      // the outage granting anyone extra reach.
      mockVerifyServicePrincipal.mockReturnValue(false);
      mockResolveOrgRollup.mockResolvedValue(undefined);
      await getHandler()(ingestReq({ user: { sub: 'u-1', scope: 'reporting:ingest', organizationId: 'parent-org' } }), res());
      expect(callerArg()).toEqual({ allowedOrgIds: ['parent-org'] });
    });

    it('fails CLOSED with an empty set when the token carries no org', async () => {
      mockVerifyServicePrincipal.mockReturnValue(false);
      await getHandler()(ingestReq({ user: { sub: 'u-1', scope: 'reporting:ingest' } }), res());
      // Empty and NOT cross-tenant ⇒ ingestEvents drops every event.
      expect(callerArg()).toEqual({ allowedOrgIds: [] });
    });

    it('counts and logs foreign-org drops rather than swallowing them', async () => {
      mockIngestEvents.mockResolvedValueOnce({
        inserted: 0,
        skipped: 0,
        unregisteredPipelineIds: [],
        affectedOrgs: [],
        droppedForeignOrg: 2,
        droppedInvalidTime: 0,
      });
      mockVerifyServicePrincipal.mockReturnValue(false);
      await getHandler()(ingestReq({ user: { sub: 'u-1', scope: 'reporting:ingest', organizationId: 'acme' } }), res());
      expect(mockIncCounter).toHaveBeenCalledWith('reporting_ingest_foreign_org_dropped_total', { org_id: 'acme' });
    });

    it('meters events dropped for impossible timestamps', async () => {
      // A bad clock on a build host skews DF/CFR/lead time for the whole org, so
      // the drop needs to be a number an operator can alert on.
      mockIngestEvents.mockResolvedValueOnce({
        inserted: 0,
        skipped: 0,
        unregisteredPipelineIds: [],
        affectedOrgs: [],
        droppedForeignOrg: 0,
        droppedInvalidTime: 3,
      });
      await getHandler()(ingestReq(), res());
      expect(mockIncCounter).toHaveBeenCalledWith('reporting_ingest_invalid_time_dropped_total', expect.anything());
    });
  });

  /**
   * GET /reports/events/last-deploy-commit — the events Lambda's cold-start
   * recovery. Its in-memory commit-range bound is empty in a fresh container, and
   * without this the next deploy resolved as a single commit: lead time far too
   * short, `commitCount` stuck at 1, on most invocations.
   */
  describe('GET last-deploy-commit', () => {
    const lookupHandler = () => routeChain(router, '/last-deploy-commit', 'get');
    const lookupReq = (query: Record<string, unknown>) => ({
      headers: {},
      query,
      user: { sub: 'svc', scope: 'reporting:ingest' },
    });

    it('returns the bound for a pipeline', async () => {
      const r = res();
      await lookupHandler()(lookupReq({ pipelineId: 'p-1' }), r);
      expect(mockSendSuccess).toHaveBeenCalledWith(r, 200, { commitSha: 'abc123', deployedAt: '2026-03-01T00:00:00Z' });
    });

    it('requires a pipelineId', async () => {
      await lookupHandler()(lookupReq({}), res());
      expect(mockSendBadRequest).toHaveBeenCalledWith(expect.anything(), expect.stringContaining('pipelineId'), expect.anything());
      expect(mockLastDeployedCommit).not.toHaveBeenCalled();
    });

    it('treats an absent environment as "last shipped anywhere"', async () => {
      // The Lambda asks while handling the SOURCE event, which carries no
      // environment — the execution has not reached a deploy stage yet.
      await lookupHandler()(lookupReq({ pipelineId: 'p-1' }), res());
      expect(mockLastDeployedCommit).toHaveBeenCalledWith('p-1', undefined, expect.anything());
    });

    it('narrows to one environment when given', async () => {
      await lookupHandler()(lookupReq({ pipelineId: 'p-1', environment: 'production' }), res());
      expect(mockLastDeployedCommit).toHaveBeenCalledWith('p-1', 'production', expect.anything());
    });

    it('ignores an empty environment rather than filtering on ""', async () => {
      await lookupHandler()(lookupReq({ pipelineId: 'p-1', environment: '' }), res());
      expect(mockLastDeployedCommit).toHaveBeenCalledWith('p-1', undefined, expect.anything());
    });

    it('enforces the SAME tenancy allow-list as the write path', async () => {
      // Without this the endpoint would hand any `reporting:ingest` holder another
      // tenant's commit history — the read-side twin of the ingest hole.
      mockVerifyServicePrincipal.mockReturnValue(false);
      mockResolveOrgRollup.mockResolvedValue(['acme', 'team-a']);
      await lookupHandler()({
        ...lookupReq({ pipelineId: 'p-1' }),
        user: { sub: 'u-1', scope: 'reporting:ingest', organizationId: 'acme' },
      }, res());
      expect(mockLastDeployedCommit).toHaveBeenCalledWith('p-1', undefined, { allowedOrgIds: ['acme', 'team-a'] });
    });

    it('fails CLOSED with an empty set when the token carries no org', async () => {
      // Same as the write path: an unknown caller reads nothing, rather than the
      // registry alone deciding what it may see.
      mockVerifyServicePrincipal.mockReturnValue(false);
      await lookupHandler()(lookupReq({ pipelineId: 'p-1' }), res());
      expect(mockLastDeployedCommit).toHaveBeenCalledWith('p-1', undefined, { allowedOrgIds: [] });
    });

    it('answers 200 with nulls when the pipeline has never deployed', async () => {
      // Not a 404: "never deployed here" is a normal answer the Lambda acts on
      // (resolve a single commit), and a 404 would be indistinguishable from a
      // wrong URL.
      mockLastDeployedCommit.mockResolvedValueOnce({ commitSha: null, deployedAt: null });
      const r = res();
      await lookupHandler()(lookupReq({ pipelineId: 'p-new' }), r);
      expect(mockSendSuccess).toHaveBeenCalledWith(r, 200, { commitSha: null, deployedAt: null });
    });
  });
});
