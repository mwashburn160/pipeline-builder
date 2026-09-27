// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

// Mock external dependencies — must be set up before importing the service
import { type AnyFn, drizzleMock, stubModule } from '@pipeline-builder/api-core/testing';
import { jest, describe, it, expect, beforeEach } from '@jest/globals';

const mockTransactionSet = jest.fn<AnyFn>().mockReturnValue({ where: jest.fn<AnyFn>() });
const mockTransactionOnConflict = jest.fn<AnyFn>().mockReturnValue({
  returning: jest.fn<AnyFn>().mockResolvedValue([{ id: 'new-pipeline', isDefault: true }]),
});
const mockTransactionValues = jest.fn<AnyFn>().mockReturnValue({
  onConflictDoUpdate: mockTransactionOnConflict,
});
// The row occupying the (project, organization, orgId) slot, as the service's
// locked conflict lookup sees it. Empty = no existing row.
let mockExistingRows: Array<Record<string, unknown>> = [];
const mockSelectFor = jest.fn(async (..._args: unknown[]) => mockExistingRows);

jest.unstable_mockModule('@pipeline-builder/pipeline-core', () => stubModule('@pipeline-builder/pipeline-core', {
  CoreConstants: { CACHE_TTL_ENTITY: 60 },
}));
jest.unstable_mockModule('@pipeline-builder/pipeline-data', () => {
  const mockFind = jest.fn<AnyFn>();
  const mockSetDefault = jest.fn<AnyFn>();

  class MockCrudService {
    find = mockFind;
    setDefault = mockSetDefault;
  }

  return stubModule('@pipeline-builder/pipeline-data', {
    CrudService: MockCrudService,

    buildPipelineConditions: jest.fn(() => []),

    withViewerContext: <T>(filter: T): T => filter,
    // The viewer is part of the findById cache key (the read predicate carries a
    // per-user `private` rung), so the mock must provide it or the module fails
    // to load. Constant here: this suite exercises the key's SHAPE; the
    // per-viewer behaviour is pinned in `pipeline-cache-viewer.test.ts`.
    viewerCacheSegment: jest.fn(() => 'v1'),
    getTenantContext: jest.fn(() => undefined),
    schema: {
      pipeline: {
        id: 'id',
        project: 'project',
        organization: 'organization',
        pipelineName: 'pipelineName',
        createdAt: 'createdAt',
        updatedAt: 'updatedAt',
        isActive: 'isActive',
        isDefault: 'isDefault',
        orgId: 'orgId',
        visibility: 'visibility',
      },
      pipelineStepManifest: { pipelineId: 'manifest.pipelineId' },
    },
    // pipeline-service.createAsDefault was migrated from db.transaction to
    // withTenantTx — same tx shape, just routed through the tenancy seam.
    withTenantTx: jest.fn(async (cb: Function) => {
      const tx = {
        execute: jest.fn<AnyFn>().mockResolvedValue([]),
        // `where(...)` is BOTH awaitable and `.for()`-able: the slot lookup awaits it
        // directly (no row lock), while the upsert's conflict read chains `.for('update')`.
        select: jest.fn(() => ({
          from: () => ({
            where: () => Object.assign(Promise.resolve(mockExistingRows), { for: mockSelectFor }),
          }),
        })),
        update: jest.fn<AnyFn>().mockReturnValue({ set: mockTransactionSet }),
        insert: jest.fn<AnyFn>().mockReturnValue({ values: mockTransactionValues }),
      };
      return cb(tx);
    }),
  });
});;

jest.unstable_mockModule('drizzle-orm', () => drizzleMock({
  SQL: class {},
  sql: jest.fn((strings: TemplateStringsArray, ...values: any[]) => ({ strings, values, type: 'sql' })),
  or: jest.fn((...args: any[]) => args),
  ilike: jest.fn((col: any, val: any) => ({ col, val, op: 'ilike' })),
  eq: jest.fn((col: any, val: any) => ({ col, val, op: 'eq' })),
  and: jest.fn((...args: any[]) => args),
  inArray: jest.fn((col: any, vals: any[]) => ({ col, vals, op: 'inArray' })),
}));

jest.unstable_mockModule('drizzle-orm/column', () => ({}));
jest.unstable_mockModule('drizzle-orm/pg-core', () => ({}));

const { PipelineService } = await import('../src/services/pipeline-service.js');
const pipelineDataMock = await import('@pipeline-builder/pipeline-data');
// api-core is NOT mocked — use the real in-process event emitter to capture the
// event the service emits to the compliance subscriber.
const { entityEvents, toComplianceAttributes } = await import('@pipeline-builder/api-core');

// Tests

describe('PipelineService', () => {
  let service: InstanceType<typeof PipelineService>;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new PipelineService();
  });

  describe('createAsDefaultReportInserted', () => {
    const data = { orgId: 'org-1', project: 'proj', organization: 'org' } as any;
    const member = { isSystemAdmin: false, canPublish: false };

    beforeEach(() => {
      mockExistingRows = [];
    });

    it('should clear existing defaults and create new pipeline in a transaction', async () => {
      const result = await service.createAsDefaultReportInserted(data, 'user-1', 'proj', 'org', member);

      // Verify the tenancy-aware transaction wrapper was used.
      const { withTenantTx } = pipelineDataMock as unknown as { withTenantTx: jest.Mock };
      expect(withTenantTx).toHaveBeenCalled();

      // The conflicting slot is looked up under a row lock before any write.
      expect(mockSelectFor).toHaveBeenCalledWith('update');

      // Verify update was called to clear defaults
      expect(mockTransactionSet).toHaveBeenCalledWith(
        expect.objectContaining({ isDefault: false }),
      );

      // Verify insert was called with isDefault: true
      expect(mockTransactionValues).toHaveBeenCalledWith(
        expect.objectContaining({ isDefault: true, isActive: true }),
      );

      expect(result.pipeline).toEqual({ id: 'new-pipeline', isDefault: true });
    });

    it('never un-deletes on the conflict branch (no deletedAt/deletedBy reset in the SET)', async () => {
      mockExistingRows = [{ visibility: 'org', createdBy: 'someone', deletedAt: null }];
      await service.createAsDefaultReportInserted(data, 'user-1', 'proj', 'org', member, { upsert: true });
      const { set } = (mockTransactionOnConflict.mock.calls[0] as any[])[0];
      expect(set).not.toHaveProperty('deletedAt');
      expect(set).not.toHaveProperty('deletedBy');
    });

    // --- overwrite gate: the ON CONFLICT branch is a write to an existing row ---

    it('refuses to resurrect a soft-deleted pipeline (409) — restore is the step-up path', async () => {
      mockExistingRows = [{ visibility: 'org', createdBy: 'user-1', deletedAt: new Date() }];
      await expect(service.createAsDefaultReportInserted(data, 'user-1', 'proj', 'org', member))
        .rejects.toMatchObject({ statusCode: 409 });
      expect(mockTransactionValues).not.toHaveBeenCalled();
      expect(mockTransactionSet).not.toHaveBeenCalled();
    });

    it('refuses a tombstone even for a system admin', async () => {
      mockExistingRows = [{ visibility: 'org', createdBy: 'user-1', deletedAt: new Date() }];
      await expect(service.createAsDefaultReportInserted(data, 'admin', 'proj', 'org', { isSystemAdmin: true, canPublish: true }))
        .rejects.toMatchObject({ statusCode: 409 });
      expect(mockTransactionValues).not.toHaveBeenCalled();
    });

    it("refuses to overwrite another author's PRIVATE pipeline (409)", async () => {
      mockExistingRows = [{ visibility: 'private', createdBy: 'user-A', deletedAt: null }];
      await expect(service.createAsDefaultReportInserted(data, 'user-B', 'proj', 'org', member))
        .rejects.toMatchObject({ statusCode: 409 });
      expect(mockTransactionValues).not.toHaveBeenCalled();
      expect(mockTransactionSet).not.toHaveBeenCalled();
    });

    it('lets the author re-create over their own private pipeline', async () => {
      mockExistingRows = [{ visibility: 'private', createdBy: 'user-A', deletedAt: null }];
      await service.createAsDefaultReportInserted(data, 'user-A', 'proj', 'org', member, { upsert: true });
      expect(mockTransactionValues).toHaveBeenCalled();
    });

    it('fails closed for an empty caller id against a private row with an empty author', async () => {
      mockExistingRows = [{ visibility: 'private', createdBy: '', deletedAt: null }];
      await expect(service.createAsDefaultReportInserted(data, '', 'proj', 'org', member))
        .rejects.toMatchObject({ statusCode: 409 });
    });

    it('refuses to overwrite a PUBLIC pipeline without pipelines:publish (403)', async () => {
      mockExistingRows = [{ visibility: 'public', createdBy: 'user-A', deletedAt: null }];
      await expect(service.createAsDefaultReportInserted(data, 'user-A', 'proj', 'org', member))
        .rejects.toMatchObject({ statusCode: 403 });
      expect(mockTransactionValues).not.toHaveBeenCalled();
    });

    it('allows a PUBLIC overwrite with pipelines:publish, and an ORG overwrite with plain write', async () => {
      mockExistingRows = [{ visibility: 'public', createdBy: 'user-A', deletedAt: null }];
      await service.createAsDefaultReportInserted(data, 'user-B', 'proj', 'org', { isSystemAdmin: false, canPublish: true }, { upsert: true });
      mockExistingRows = [{ visibility: 'org', createdBy: 'user-A', deletedAt: null }];
      await service.createAsDefaultReportInserted(data, 'user-B', 'proj', 'org', member, { upsert: true });
      expect(mockTransactionValues).toHaveBeenCalledTimes(2);
    });

    it("lets a system admin overwrite another author's private pipeline", async () => {
      mockExistingRows = [{ visibility: 'private', createdBy: 'user-A', deletedAt: null }];
      await service.createAsDefaultReportInserted(data, 'admin', 'proj', 'org', { isSystemAdmin: true, canPublish: false }, { upsert: true });
      expect(mockTransactionValues).toHaveBeenCalled();
    });

    // --- overwrite is OPT-IN: a plain create never replaces a live pipeline ---
    //
    // The gate above answers "who MAY overwrite". This answers "was an overwrite
    // asked for at all" — previously nothing did, so a second create for the same
    // slot silently replaced a live pipeline's props and still returned 201.

    it('refuses a create into a taken slot without upsert (409)', async () => {
      mockExistingRows = [{ id: 'existing-1', pipelineName: 'acme-proj-pipeline', visibility: 'org', createdBy: 'user-1', deletedAt: null }];
      await expect(service.createAsDefaultReportInserted(data, 'user-1', 'proj', 'org', member))
        .rejects.toMatchObject({ statusCode: 409 });
      // Nothing was written — not even the clear-other-defaults UPDATE.
      expect(mockTransactionValues).not.toHaveBeenCalled();
      expect(mockTransactionSet).not.toHaveBeenCalled();
    });

    it('names the existing pipeline and the NORMALIZED slot in the 409 details', async () => {
      // Normalization is how `My-App` and `my_app` reach the same slot, so the
      // details echo the pair that actually collided — not what was sent.
      mockExistingRows = [{ id: 'existing-1', pipelineName: 'acme-proj-pipeline', visibility: 'org', createdBy: 'user-1', deletedAt: null }];
      await expect(service.createAsDefaultReportInserted(data, 'user-1', 'proj', 'org', member))
        .rejects.toMatchObject({
          statusCode: 409,
          details: {
            pipelineId: 'existing-1',
            pipelineName: 'acme-proj-pipeline',
            normalized: { project: 'proj', organization: 'org' },
          },
        });
    });

    it('still inserts into a FREE slot without upsert', async () => {
      mockExistingRows = [];
      const result = await service.createAsDefaultReportInserted(data, 'user-1', 'proj', 'org', member);
      expect(mockTransactionValues).toHaveBeenCalled();
      expect(result.pipeline).toEqual({ id: 'new-pipeline', isDefault: true });
    });

    it('checks the tombstone BEFORE the upsert gate, so upsert cannot resurrect one', async () => {
      // `?upsert=true` must not become a step-up-free back door around restore.
      mockExistingRows = [{ id: 'existing-1', visibility: 'org', createdBy: 'user-1', deletedAt: new Date() }];
      await expect(service.createAsDefaultReportInserted(data, 'user-1', 'proj', 'org', member, { upsert: true }))
        .rejects.toMatchObject({ statusCode: 409 });
      expect(mockTransactionValues).not.toHaveBeenCalled();
    });

    it('honours isActive: false instead of forcing every pipeline active', async () => {
      // The CLI's `--no-active` used to be stripped by the create schema and then
      // overridden here, so a paused pipeline was impossible to create.
      mockExistingRows = [];
      await service.createAsDefaultReportInserted({ ...data, isActive: false }, 'user-1', 'proj', 'org', member);
      expect(mockTransactionValues).toHaveBeenCalledWith(
        expect.objectContaining({ isDefault: true, isActive: false }),
      );
    });

    it('defaults to active when isActive is not supplied', async () => {
      mockExistingRows = [];
      await service.createAsDefaultReportInserted(data, 'user-1', 'proj', 'org', member);
      expect(mockTransactionValues).toHaveBeenCalledWith(
        expect.objectContaining({ isDefault: true, isActive: true }),
      );
    });
  });

  // The buildConditions override must FORWARD parentOrgId
  // to buildPipelineConditions so a team org's reads widen to its parent's public
  // pipelines (org → team hierarchy). Previously the override dropped the third
  // arg, so the widening the base CrudService requested was silently lost.
  describe('buildConditions parentOrgId threading', () => {
    it('forwards parentOrgId to buildPipelineConditions', () => {
      const { buildPipelineConditions } = pipelineDataMock as unknown as { buildPipelineConditions: jest.Mock };
      (service as any).buildConditions({ pipelineName: 'p' }, 'team-org', 'parent-org');
      expect(buildPipelineConditions).toHaveBeenCalledWith({ pipelineName: 'p' }, 'team-org', 'parent-org');
    });

    it('passes parentOrgId=undefined for a root org (no widening)', () => {
      const { buildPipelineConditions } = pipelineDataMock as unknown as { buildPipelineConditions: jest.Mock };
      (service as any).buildConditions({}, 'root-org');
      expect(buildPipelineConditions).toHaveBeenCalledWith({}, 'root-org', undefined);
    });
  });

  /**
   * `findOneBySlot` answers "would a create land here?", so it deliberately
   * bypasses the visibility/soft-delete READ predicate: the unique index that
   * actually decides is blind to both, and a caller who cannot read the occupying
   * row still has to be told the slot is taken. It returns only the slot columns
   * and lifecycle state — never `props`.
   */
  describe('findOneBySlot', () => {
    it('returns the occupying row, including a soft-deleted tombstone', async () => {
      const deletedAt = new Date();
      mockExistingRows = [{ id: 'p-1', pipelineName: 'acme-web', visibility: 'org', deletedAt }];
      const row = await service.findOneBySlot('web', 'acme', 'org-1');
      expect(row).toEqual({ id: 'p-1', pipelineName: 'acme-web', visibility: 'org', deletedAt });
    });

    it('returns null for a free slot', async () => {
      mockExistingRows = [];
      expect(await service.findOneBySlot('web', 'acme', 'org-1')).toBeNull();
    });

    it('never selects props — the caller may not be allowed to read them', async () => {
      mockExistingRows = [{ id: 'p-1', pipelineName: 'n', visibility: 'private', deletedAt: null }];
      const row = await service.findOneBySlot('web', 'acme', 'org-1');
      expect(row).not.toHaveProperty('props');
    });
  });

  describe('getSortColumn', () => {
    it('should return a column for valid sortBy values', () => {
      const validFields = ['id', 'project', 'organization', 'pipelineName', 'createdAt', 'updatedAt', 'isActive', 'isDefault'];

      for (const field of validFields) {
        const result = (service as any).getSortColumn(field);
        expect(result).not.toBeNull();
      }
    });

    it('should return null for invalid sortBy value', () => {
      const result = (service as any).getSortColumn('nonexistent');
      expect(result).toBeNull();
    });
  });

  // A pipeline row whose serialized `props` embeds secrets: a synth-level env
  // map, a per-step env map, a step buildArgs map, and a source `token`. The
  // compliance event must keep structure + keys (compliance traverses
  // props.stages / $keys(env) / path checks) but NEVER carry plaintext values.
  const secretPipeline = {
    id: 'pipeline-1',
    orgId: 'org-1',
    project: 'proj',
    organization: 'org',
    pipelineName: 'my-pipeline',
    visibility: 'private',
    props: {
      project: 'proj',
      organization: 'org',
      synth: {
        env: { NPM_TOKEN: 'SYNTHSECRET1', NODE_VERSION: '24' },
        source: { token: 'ghp_SOURCESECRET' },
      },
      stages: [
        {
          stageName: 'build',
          steps: [
            { plugin: 'docker', env: { REGISTRY_PASSWORD: 'STEPSECRET2' }, buildArgs: { GH_TOKEN: 'STEPSECRET3' } },
          ],
        },
      ],
    },
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-02T00:00:00Z'),
  } as any;

  describe('compliance event emission — secret redaction', () => {
    it('emits props structure/keys but never secret VALUES', async () => {
      const captured: any[] = [];
      const subscriber = { onEntityEvent: async (e: any) => { captured.push(e); } };
      entityEvents.subscribe(subscriber);
      try {
        await (service as any).onAfterCreate(secretPipeline, 'user-1');
      } finally {
        entityEvents.unsubscribe(subscriber);
      }

      expect(captured).toHaveLength(1);
      const event = captured[0];
      // Event envelope unchanged.
      expect(event.eventType).toBe('created');
      expect(event.target).toBe('pipeline');
      expect(event.entityId).toBe('pipeline-1');
      expect(event.orgId).toBe('org-1');

      // No secret VALUE anywhere in the serialized payload.
      const serialized = JSON.stringify(event.attributes);
      for (const secret of ['SYNTHSECRET1', 'STEPSECRET2', 'STEPSECRET3', 'ghp_SOURCESECRET']) {
        expect(serialized).not.toContain(secret);
      }

      // Compliance-relevant structure + keys survive for rule evaluation.
      expect(event.attributes.project).toBe('proj');
      expect(event.attributes.props.stages).toHaveLength(1);
      expect(event.attributes.props.stages[0].steps[0].plugin).toBe('docker');
      expect(Object.keys(event.attributes.props.synth.env)).toEqual(['NPM_TOKEN', 'NODE_VERSION']);
      expect(Object.keys(event.attributes.props.stages[0].steps[0].env)).toEqual(['REGISTRY_PASSWORD']);
    });
  });

  describe('toComplianceAttributes', () => {
    it('redacts nested env/buildArgs values + source token, preserves keys and Dates', () => {
      const projected: any = toComplianceAttributes(secretPipeline);
      expect(projected.props.synth.env).toEqual({ NPM_TOKEN: '[REDACTED]', NODE_VERSION: '[REDACTED]' });
      expect(projected.props.synth.source.token).toBe('[REDACTED]');
      expect(projected.props.stages[0].steps[0].env).toEqual({ REGISTRY_PASSWORD: '[REDACTED]' });
      expect(projected.props.stages[0].steps[0].buildArgs).toEqual({ GH_TOKEN: '[REDACTED]' });
      // Dates must not be corrupted into {} by the recursive walk.
      expect(projected.createdAt).toBeInstanceOf(Date);
    });
  });

});

describe('PipelineService purge teardown', () => {
  it('deletes the purged pipelines\u2019 step manifests inside the purge transaction', async () => {
    const where = jest.fn(async (..._args: unknown[]) => undefined);
    const del = jest.fn((..._args: unknown[]) => ({ where }));
    const svc = new PipelineService() as any;
    await svc.onBeforePurge(['p1', 'p2'], { delete: del });
    expect(del).toHaveBeenCalledWith({ pipelineId: 'manifest.pipelineId' });
    expect(where).toHaveBeenCalledWith({ col: 'manifest.pipelineId', vals: ['p1', 'p2'], op: 'inArray' });
  });

  it('is a no-op for an empty batch', async () => {
    const del = jest.fn<AnyFn>();
    await (new PipelineService() as any).onBeforePurge([], { delete: del });
    expect(del).not.toHaveBeenCalled();
  });
});
