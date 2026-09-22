// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for POST /pipelines/registry endpoint.
 */

import { type AnyFn, drizzleMock, stubModule } from '@pipeline-builder/api-core/testing';
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

const mockInsert = jest.fn<AnyFn>();
const mockOnConflictDoUpdate = jest.fn<AnyFn>();
const mockReturning = jest.fn<AnyFn>();
const mockSelect = jest.fn<AnyFn>();
const mockDelete = jest.fn<AnyFn>();

const mockEmitPipelineAudit = jest.fn<AnyFn>();
jest.unstable_mockModule('../src/services/audit.js', () => ({
  emitPipelineAudit: mockEmitPipelineAudit,
  getAuditClient: () => ({ record: jest.fn<AnyFn>() }),
}));

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  sendSuccess: jest.fn<AnyFn>(),
  sendBadRequest: jest.fn<AnyFn>(),
  sendError: jest.fn<AnyFn>(),
  sendPaginatedNested: jest.fn<AnyFn>(),
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

jest.unstable_mockModule('@pipeline-builder/api-server', () => stubModule('@pipeline-builder/api-server', {
  incCounter: () => undefined,
  checkQuota: () => (_req: any, _res: any, next: () => void) => next(),
  withRoute: (handler: any) => async (req: any, res: any) => {
    const ctx = { log: jest.fn<AnyFn>(), identity: { orgId: 'acme', userId: 'user-1' }, requestId: 'req-1' };
    await handler({ req, res, ctx, orgId: 'acme', userId: 'user-1' });
  },
}));

const actualData = jest.requireActual('@pipeline-builder/pipeline-data') as Record<string, unknown>;
/** The listing data source the manifest's listed-version check reads (W2). */
const mockListingSource = {
  liveListings: jest.fn(async (): Promise<unknown[]> => []),
  publishersByIds: jest.fn(async (): Promise<unknown[]> => []),
  installsForOrgs: jest.fn(async (..._args: unknown[]): Promise<unknown[]> => []),
  policiesForOrgs: jest.fn(async (): Promise<unknown[]> => []),
};
const mockRunWithTenantContext = jest.fn((_ctx: unknown, fn: () => unknown) => fn());
jest.unstable_mockModule('@pipeline-builder/pipeline-data', () => stubModule('@pipeline-builder/pipeline-data', {
  // pipeline-registry-service was migrated to withTenantTx — hand the tx the
  // same spies registry.test.ts already tracks so existing assertions hold.
  withTenantTx: (fn: (tx: unknown) => unknown) => fn({
    insert: mockInsert,
    select: mockSelect,
    delete: mockDelete,
  }),
  runWithTenantContext: mockRunWithTenantContext,
  drizzleListingSource: () => mockListingSource,
  loadOrgInstallContext: actualData.loadOrgInstallContext,
  installModeFor: actualData.installModeFor,
  listingBlock: actualData.listingBlock,
  schema: {
    pluginListingVersion: { id: 'id', listingId: 'listing_id', version: 'version', imageDigest: 'image_digest', imageRepository: 'image_repository', _table: 'plugin_listing_versions' },
    pipelineStepManifest: { pipelineId: 'pipeline_id', orgId: 'org_id', _table: 'pipeline_step_manifests' },
    plugin: { id: 'id', orgId: 'org_id', name: 'name', version: 'version', imageDigest: 'image_digest', buildType: 'build_type' },
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

jest.unstable_mockModule('drizzle-orm', () => drizzleMock({
  and: (...args: unknown[]) => ({ _kind: 'and', args }),
  eq: (col: unknown, val: unknown) => ({ _kind: 'eq', col, val }),
  inArray: (col: unknown, vals: unknown[]) => ({ _kind: 'inArray', col, vals }),
  desc: (col: unknown) => ({ _kind: 'desc', col }),
  // Capture the tagged-template SQL so tests can assert on COALESCE-style
  // conditional updates (e.g. region is preserved, not nulled, on partial re-register).
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({ _kind: 'sql', text: strings.join('?'), values }),
}));

const { sendSuccess, sendBadRequest, sendError, sendPaginatedNested } = await import('@pipeline-builder/api-core') as unknown as Record<string, jest.Mock<AnyFn>>;
const { createRegistryRoutes } = await import('../src/routes/registry.js');

describe('POST /pipelines/registry', () => {
  let router: any;

  beforeEach(() => {
    jest.clearAllMocks();
    router = createRegistryRoutes();

    mockReturning.mockResolvedValue([{ id: 'reg-1', pipelineId: 'p-1' }]);
    mockOnConflictDoUpdate.mockReturnValue({ returning: mockReturning });
    mockInsert.mockReturnValue({
      values: jest.fn<AnyFn>().mockReturnValue({
        onConflictDoUpdate: mockOnConflictDoUpdate,
      }),
    });

    // Default db.select chain: pipeline lookup returns a hit, registry lookup
    // returns no existing row (so the upsert proceeds to insert).
    let selectCallCount = 0;
    mockSelect.mockImplementation(() => ({
      from: jest.fn<AnyFn>().mockImplementation(() => ({
        where: jest.fn<AnyFn>().mockImplementation(() => {
          selectCallCount++;
          // Call 1 = pipeline tenancy lookup → return one row.
          // Call 2 = existing-registry lookup → return empty (new ARN).
          return Promise.resolve(selectCallCount === 1 ? [{ id: 'p-1' }] : []);
        }),
      })),
    }));

    // Default delete chain: delete().where().returning() → one removed row.
    mockDelete.mockReturnValue({
      where: jest.fn<AnyFn>().mockReturnValue({
        returning: jest.fn<AnyFn>().mockResolvedValue([{ id: 'reg-1', pipelineId: 'p-1' }]),
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
    // `withRoute` runs the handler without returning its promise, so awaiting the
    // chain only gets us as far as the first await inside it. Flush the pending
    // microtasks so the response call has happened before the assertions.
    await new Promise((resolve) => setImmediate(resolve));
  }

  it('should reject missing required fields', async () => {
    const handler = getHandler();
    const req = { body: { pipelineId: 'p-1' } }; // missing pipelineArn and pipelineName
    const res = { status: jest.fn<AnyFn>().mockReturnThis(), json: jest.fn<AnyFn>() };

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
    const res = { status: jest.fn<AnyFn>().mockReturnThis(), json: jest.fn<AnyFn>() };

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
    const res = { status: jest.fn<AnyFn>().mockReturnThis(), json: jest.fn<AnyFn>() };

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
      from: jest.fn<AnyFn>().mockImplementation(() => ({
        where: jest.fn<AnyFn>().mockResolvedValue([]),
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
    const res = { status: jest.fn<AnyFn>().mockReturnThis(), json: jest.fn<AnyFn>() };
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
      from: jest.fn<AnyFn>().mockImplementation(() => ({
        where: jest.fn<AnyFn>().mockImplementation(() => {
          call++;
          if (call === 1) return Promise.resolve([{ id: 'p-1' }]);
          return Promise.resolve([{ orgId: 'OTHER-org' }]);
        }),
      })),
    }));

    const handler = getHandler();
    const res = { status: jest.fn<AnyFn>().mockReturnThis(), json: jest.fn<AnyFn>() };
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
      from: jest.fn<AnyFn>().mockImplementation(() => ({
        where: jest.fn<AnyFn>().mockImplementation(() => {
          callCount++;
          if (callCount === 1) return Promise.resolve([{ count: 1 }]);
          // The list query has additional .orderBy/.limit/.offset chained
          return {
            orderBy: jest.fn<AnyFn>().mockReturnValue({
              limit: jest.fn<AnyFn>().mockReturnValue({
                offset: jest.fn<AnyFn>().mockResolvedValue([
                  { id: 'reg-1', pipelineId: 'p-1', pipelineName: 'demo', lastDeployed: new Date() },
                ]),
              }),
            }),
          };
        }),
      })),
    }));

    const handler = getHandler('get');
    const res = { status: jest.fn<AnyFn>().mockReturnThis(), json: jest.fn<AnyFn>() };
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
      const res = { status: jest.fn<AnyFn>().mockReturnThis(), json: jest.fn<AnyFn>() };
      await runStack('/registry', 'post', { body, user: { capabilities: ['pipelines:read'] } }, res);
      expect(res.status).toHaveBeenCalledWith(403);
      expect(mockInsert).not.toHaveBeenCalled();
    });

    it('POST /registry → allowed with pipelines:write (upserts)', async () => {
      const res = { status: jest.fn<AnyFn>().mockReturnThis(), json: jest.fn<AnyFn>() };
      await runStack('/registry', 'post', { body, user: { capabilities: ['pipelines:write'] } }, res);
      expect(mockInsert).toHaveBeenCalled();
      expect(sendSuccess).toHaveBeenCalled();
    });

    it('DELETE /registry/:id → 403 without pipelines:write (no delete)', async () => {
      const res = { status: jest.fn<AnyFn>().mockReturnThis(), json: jest.fn<AnyFn>() };
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
      const res = { status: jest.fn<AnyFn>().mockReturnThis(), json: jest.fn<AnyFn>() };
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
        from: jest.fn<AnyFn>().mockImplementation(() => ({
          where: jest.fn<AnyFn>().mockResolvedValue([]),
        })),
      }));
      const handler = getHandler('post');
      const req = { body: { pipelineId: 'p-x', pipelineName: 'x' } };
      const res = { status: jest.fn<AnyFn>().mockReturnThis(), json: jest.fn<AnyFn>() };
      await handler(req, res);

      expect(mockEmitPipelineAudit).not.toHaveBeenCalled();
    });

    it('DELETE /registry/:id emits pipeline.registry.deregister with targetId=pipelineId and no ARN/account', async () => {
      const handler = router.stack.find(
        (l: any) => l.route?.path === '/registry/:id' && l.route?.methods?.delete,
      )?.route?.stack;
      const deleteHandler = handler[handler.length - 1].handle;

      const res = { status: jest.fn<AnyFn>().mockReturnThis(), json: jest.fn<AnyFn>() };
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
        where: jest.fn<AnyFn>().mockReturnValue({
          returning: jest.fn<AnyFn>().mockResolvedValue([]),
        }),
      });
      const handler = router.stack.find(
        (l: any) => l.route?.path === '/registry/:id' && l.route?.methods?.delete,
      )?.route?.stack;
      const deleteHandler = handler[handler.length - 1].handle;

      const res = { status: jest.fn<AnyFn>().mockReturnThis(), json: jest.fn<AnyFn>() };
      await deleteHandler({ params: { id: 'missing' } }, res);

      expect(mockEmitPipelineAudit).not.toHaveBeenCalled();
    });
  });

  // W0.1 step manifest: a post-deploy registration carries the synth's
  // (stage, action) → plugin map and REPLACES the stored one in the same tx.
  describe('step manifest', () => {
    const DIGEST = `sha256:${'a'.repeat(64)}`;
    const step = (over: Record<string, unknown> = {}) => ({
      stageName: 'test-wave',
      actionName: 'stage_abc_test-wave_jest_1',
      pluginId: '11111111-1111-4111-8111-111111111111',
      pluginName: 'jest',
      pluginVersion: '9.9.9',
      imageDigest: null,
      ...over,
    });

    /** listing versions (read first, elevated), then select #1 pipeline, #2 existing registry, #3 plugin rows. Captures manifest inserts. */
    function wireManifest(pluginRows: Array<Record<string, unknown>>, listingVersionRows: Array<Record<string, unknown>> = []) {
      let call = 0;
      mockSelect.mockImplementation(() => ({
        from: jest.fn<AnyFn>().mockImplementation((table: any) => ({
          where: jest.fn<AnyFn>().mockImplementation(() => {
            if (table?._table === 'plugin_listing_versions') return Promise.resolve(listingVersionRows);
            call++;
            if (call === 1) return Promise.resolve([{ id: 'p-1' }]);
            if (call === 2) return Promise.resolve([]);
            return Promise.resolve(pluginRows);
          }),
        })),
      }));
      const manifestValues = jest.fn<AnyFn>().mockResolvedValue(undefined);
      mockInsert.mockImplementation((table: any) => (table?._table === 'pipeline_step_manifests'
        ? { values: manifestValues }
        : { values: jest.fn<AnyFn>().mockReturnValue({ onConflictDoUpdate: mockOnConflictDoUpdate }) }));
      const manifestDeleteWhere = jest.fn<AnyFn>().mockResolvedValue(undefined);
      mockDelete.mockReturnValue({ where: manifestDeleteWhere });
      return { manifestValues, manifestDeleteWhere };
    }

    it('replaces the manifest with rows resolved from the plugin records (not the CLI claim)', async () => {
      // `jest` is a listed Official version the org reaches implicitly; `lint` its own row.
      mockListingSource.liveListings.mockResolvedValueOnce([{ id: 'l-jest', publisherId: 'pub-o', name: 'jest', state: 'listed' }]);
      mockListingSource.publishersByIds.mockResolvedValueOnce([{ id: 'pub-o', handle: 'pipeline-builder', tier: 'official', suspendedAt: null }]);
      const { manifestValues, manifestDeleteWhere } = wireManifest([
        { id: '22222222-2222-4222-8222-222222222222', orgId: 'acme', name: 'lint', version: '1.0.0', imageDigest: null, buildType: 'metadata_only' },
      ], [
        { id: '11111111-1111-4111-8111-111111111111', listingId: 'l-jest', version: '2.0.0', imageDigest: DIGEST, imageRepository: 'public/pipeline-builder/jest' },
      ]);
      const res = { status: jest.fn<AnyFn>().mockReturnThis(), json: jest.fn<AnyFn>() };
      await getHandler('post')({
        body: {
          pipelineId: 'p-1',
          pipelineName: 'acme-pipeline',
          steps: [
            step(),
            step({ actionName: 'lint', pluginId: '22222222-2222-4222-8222-222222222222', pluginName: 'lint' }),
            // Names a plugin the caller can't see (RLS returned no row) → dropped.
            step({ actionName: 'foreign', pluginId: '33333333-3333-4333-8333-333333333333' }),
          ],
        },
      }, res);

      expect(manifestDeleteWhere).toHaveBeenCalledWith({ _kind: 'eq', col: 'pipeline_id', val: 'p-1' });
      const rows = manifestValues.mock.calls[0][0] as Array<Record<string, unknown>>;
      expect(rows).toHaveLength(2);
      expect(rows[0]).toEqual(expect.objectContaining({
        pipelineId: 'p-1',
        orgId: 'acme',
        stageName: 'test-wave',
        actionName: 'stage_abc_test-wave_jest_1',
        // A listed version → its publisher and public/* copy; version from the RECORD, not the claimed 9.9.9.
        pluginPublisher: 'pipeline-builder',
        // …and its publisher ID, which the cross-org stats join on (a handle can change).
        pluginPublisherId: 'pub-o',
        pluginName: 'jest',
        pluginVersion: '2.0.0',
        imageDigest: DIGEST,
        imageRepository: 'public/pipeline-builder/jest',
      }));
      // Own-org plugin → no publisher; image-less → no repository.
      expect(rows[1]).toEqual(expect.objectContaining({ pluginPublisher: null, pluginPublisherId: null, pluginName: 'lint', imageDigest: null, imageRepository: null }));
      expect(mockRunWithTenantContext).toHaveBeenCalledWith({ isSuperAdmin: true }, expect.any(Function));
      expect(mockEmitPipelineAudit.mock.calls[0][0]).toEqual(expect.objectContaining({
        details: expect.objectContaining({ manifestSteps: 2 }),
      }));
    });

    it('drops a listed version the org does not reach (not installed / blocked), and records an own row\'s own namespace', async () => {
      mockListingSource.liveListings.mockResolvedValueOnce([
        { id: 'l-acme', publisherId: 'pub-a', name: 'scan', state: 'listed' },
        { id: 'l-blocked', publisherId: 'pub-o', name: 'trivy', state: 'listed' },
      ]);
      mockListingSource.publishersByIds.mockResolvedValueOnce([
        { id: 'pub-a', handle: 'acme', tier: 'verified', suspendedAt: null },
        { id: 'pub-o', handle: 'pipeline-builder', tier: 'official', suspendedAt: null },
      ]);
      mockListingSource.policiesForOrgs.mockResolvedValueOnce([{ orgId: 'acme', blockedListings: [{ publisher: 'pipeline-builder', name: 'trivy' }] }]);
      const { manifestValues } = wireManifest([
        { id: '44444444-4444-4444-8444-444444444444', orgId: 'acme', name: 'own', version: '1.0.0', imageDigest: DIGEST, buildType: 'build_image' },
      ], [
        { id: '11111111-1111-4111-8111-111111111111', listingId: 'l-acme', version: '1.0.0', imageDigest: DIGEST, imageRepository: 'public/acme/scan' },
        { id: '22222222-2222-4222-8222-222222222222', listingId: 'l-blocked', version: '1.0.0', imageDigest: DIGEST, imageRepository: 'public/pipeline-builder/trivy' },
        { id: '33333333-3333-4333-8333-333333333333', listingId: 'l-gone', version: '1.0.0', imageDigest: DIGEST, imageRepository: 'public/x/y' },
      ]);
      const res = { status: jest.fn<AnyFn>().mockReturnThis(), json: jest.fn<AnyFn>() };
      await getHandler('post')({
        user: { parentOrganizationId: 'root-1' },
        body: {
          pipelineId: 'p-1',
          pipelineName: 'acme-pipeline',
          steps: [
            step(),
            step({ actionName: 'b', pluginId: '22222222-2222-4222-8222-222222222222' }),
            step({ actionName: 'c', pluginId: '33333333-3333-4333-8333-333333333333' }),
            step({ actionName: 'd', pluginId: '44444444-4444-4444-8444-444444444444' }),
          ],
        },
      }, res);
      const rows = manifestValues.mock.calls[0][0] as Array<Record<string, unknown>>;
      expect(rows).toEqual([expect.objectContaining({ actionName: 'd', pluginPublisher: null, imageRepository: 'org-acme/own' })]);
      expect(mockListingSource.installsForOrgs).toHaveBeenCalledWith(['acme', 'root-1']);
    });

    it('an empty steps array clears the manifest', async () => {
      const { manifestValues, manifestDeleteWhere } = wireManifest([]);
      const res = { status: jest.fn<AnyFn>().mockReturnThis(), json: jest.fn<AnyFn>() };
      await getHandler('post')({ body: { pipelineId: 'p-1', pipelineName: 'acme-pipeline', steps: [] } }, res);
      expect(manifestDeleteWhere).toHaveBeenCalled();
      expect(manifestValues).not.toHaveBeenCalled();
    });

    it('a registration without steps leaves the stored manifest untouched', async () => {
      const { manifestDeleteWhere } = wireManifest([]);
      const res = { status: jest.fn<AnyFn>().mockReturnThis(), json: jest.fn<AnyFn>() };
      await getHandler('post')({ body: { pipelineId: 'p-1', pipelineName: 'acme-pipeline' } }, res);
      expect(manifestDeleteWhere).not.toHaveBeenCalled();
      expect(sendSuccess).toHaveBeenCalled();
    });

    it('rejects a malformed manifest entry', async () => {
      const res = { status: jest.fn<AnyFn>().mockReturnThis(), json: jest.fn<AnyFn>() };
      await getHandler('post')({ body: { pipelineId: 'p-1', pipelineName: 'x', steps: [step({ pluginId: 'not-a-uuid' })] } }, res);
      expect(sendBadRequest).toHaveBeenCalled();
      expect(mockInsert).not.toHaveBeenCalled();
    });

    it('deregistering a pipeline drops its manifest too', async () => {
      const manifestWhere = jest.fn<AnyFn>().mockResolvedValue(undefined);
      mockDelete
        .mockReturnValueOnce({ where: jest.fn<AnyFn>().mockReturnValue({ returning: jest.fn<AnyFn>().mockResolvedValue([{ id: 'reg-1', pipelineId: 'p-1' }]) }) })
        .mockReturnValueOnce({ where: manifestWhere });
      const stack = router.stack.find((l: any) => l.route?.path === '/registry/:id' && l.route?.methods?.delete)?.route?.stack;
      const res = { status: jest.fn<AnyFn>().mockReturnThis(), json: jest.fn<AnyFn>() };
      await stack[stack.length - 1].handle({ params: { id: 'reg-1' } }, res);
      expect(manifestWhere).toHaveBeenCalledWith(expect.objectContaining({ _kind: 'and' }));
    });
  });
});
