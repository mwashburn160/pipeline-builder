// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { type AnyFn, drizzleMock, stubModule } from '@pipeline-builder/api-core/testing';

// Mock external dependencies — must be set up before importing the service
const mockFind = jest.fn<AnyFn>();
const mockSetDefault = jest.fn<AnyFn>();
// Base CrudService.update / updateMany — what the PluginService overrides delegate to.
const mockSuperUpdate = jest.fn<(...a: any[]) => Promise<any>>();
const mockSuperUpdateMany = jest.fn<(...a: any[]) => Promise<any[]>>();

// The REAL semver helpers (pure functions), loaded BEFORE any mock is registered:
// the default-version rule and the in-use count must be exercised against the
// actual comparison, not a stub. (semver-range imports drizzle-orm, which this
// suite mocks below — importing it first binds the real one.)
// The real raw-result reader (a pure function), loaded before the module mock.
const realPgResult = await import('@pipeline-builder/pipeline-data/lib/database/pg-result.js');
const realSemver = await import('@pipeline-builder/pipeline-data/lib/api/semver-range.js');
const mockPluginResolutionOrderBy = jest.fn((..._a: any[]) => ['resolution-order']);
// api-core is never mocked in this suite, so the real system-org id is safe to load first.
const { SYSTEM_ORG_ID } = await import('@pipeline-builder/api-core');

jest.unstable_mockModule('@pipeline-builder/pipeline-core', () => stubModule('@pipeline-builder/pipeline-core', {
  CoreConstants: { CACHE_TTL_ENTITY: 60 },
  // Mirrors pipeline-core's owner-namespaced repository rule.
  pluginImageRepository: (p: any) => (p.buildType === 'metadata_only' ? null : `${p.orgId === SYSTEM_ORG_ID ? 'system' : `org-${p.orgId}`}/${p.name}`),
  ComputeType: {},
  PluginType: {},
}));
jest.unstable_mockModule('@pipeline-builder/pipeline-data', () => {
  class MockCrudService {
    find = mockFind;
    setDefault = mockSetDefault;
    update(...a: any[]) { return mockSuperUpdate(...a); }
    updateMany(...a: any[]) { return mockSuperUpdateMany(...a); }
  }

  return stubModule('@pipeline-builder/pipeline-data', {
    executeRows: realPgResult.executeRows,
    CrudService: MockCrudService,
    buildPluginConditions: jest.fn(() => []),
    withViewerContext: <T>(filter: T): T => filter,
    // The viewer is part of the findById cache key (the read predicate carries a
    // per-user `private` rung), so the mock must provide it or the module fails
    // to load. Constant here: this suite exercises the key's SHAPE; the
    // per-viewer behaviour is pinned in pipeline-data's viewer-context tests.
    viewerCacheSegment: jest.fn(() => 'v1'),
    getTenantContext: jest.fn(() => undefined),
    withTenantTx: jest.fn<AnyFn>(),
    parseSemver: realSemver.parseSemver,
    compareSemverParts: realSemver.compareSemverParts,
    satisfiesVersionSpec: realSemver.satisfiesVersionSpec,
    semverOrderBy: jest.fn(() => []),
    pluginResolutionOrderBy: mockPluginResolutionOrderBy,
    runWithTenantContext: jest.fn((_ctx: unknown, fn: () => unknown) => fn()),
    OFFICIAL_PUBLISHER_HANDLE: 'pipeline-builder',
    schema: {
      plugin: {
        id: 'id',
        name: 'name',
        version: 'version',
        description: 'description',
        createdAt: 'createdAt',
        updatedAt: 'updatedAt',
        isActive: 'isActive',
        isDefault: 'isDefault',
        orgId: 'orgId',
        visibility: 'visibility',
      },
      pipelineStepManifest: {
        orgId: 'manifest.orgId',
        pluginName: 'manifest.pluginName',
        pluginVersion: 'manifest.pluginVersion',
        pluginPublisher: 'manifest.pluginPublisher',
        imageRepository: 'manifest.imageRepository',
      },
    },
  });
});;

// Records each tagged template's text + values so a test can read back the SQL
// a query was built from.
const mockSql = jest.fn((strings?: any, ...vals: any[]) => ({ text: Array.isArray(strings) ? strings.join('?') : '', vals }));
jest.unstable_mockModule('drizzle-orm', () => drizzleMock({
  SQL: class {},
  sql: Object.assign(mockSql, { raw: (..._a: any[]) => ({}) }),
  and: jest.fn((...args: any[]) => args),
  or: jest.fn((...args: any[]) => args),
  ilike: jest.fn((col: any, val: any) => ({ col, val, op: 'ilike' })),
  eq: jest.fn((col: any, val: any) => ({ col, val, op: 'eq' })),
  isNull: jest.fn((col: any) => ({ col, op: 'isNull' })),
  ne: jest.fn((col: any, val: any) => ({ col, val, op: 'ne' })),
  inArray: jest.fn((col: any, vals: any[]) => ({ col, vals, op: 'inArray' })),
}));

// Installing orgs of a row's listing versions — the fan-out has its own suite.
const mockInstallingOrgs = jest.fn(async (..._args: unknown[]): Promise<Array<{ orgId: string; install: null }>> => []);
const mockVersionsBySource = jest.fn(async (..._args: unknown[]): Promise<any[]> => []);
const mockListingById = jest.fn(async (..._args: any[]): Promise<any> => null);
const mockPublisherById = jest.fn(async (): Promise<any> => null);
jest.unstable_mockModule('../src/services/ecosystem/install-notify.js', () => ({ installingOrgs: mockInstallingOrgs }));
jest.unstable_mockModule('../src/services/ecosystem/store.js', () => ({
  versions: { bySourcePlugins: mockVersionsBySource },
  // The real lookup's shape over the per-id mocks.
  listingsWithPublishers: async (ids: string[]) => {
    const out = new Map<string, { listing: any; publisher: any }>();
    for (const id of new Set(ids)) {
      const listing = await mockListingById(id);
      if (listing) out.set(id, { listing, publisher: await (mockPublisherById as any)(listing.publisherId) });
    }
    return out;
  },
}));
jest.unstable_mockModule('drizzle-orm/column', () => ({}));
jest.unstable_mockModule('drizzle-orm/pg-core', () => ({}));

const { PluginService } = await import('../src/services/plugin-service.js');
const pipelineDataMock = await import('@pipeline-builder/pipeline-data') as unknown as { withTenantTx: jest.Mock };
// api-core is NOT mocked — use the real in-process event emitter to capture the
// event the service emits to the compliance subscriber.
const { entityEvents, toComplianceAttributes } = await import('@pipeline-builder/api-core');

// Tests

describe('PluginService', () => {
  let service: InstanceType<typeof PluginService>;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new PluginService();
  });

  // deployVersion's ON CONFLICT (name, version, org_id) branch is a WRITE to an
  // existing row: it must apply the visibility ladder and refuse a tombstone.
  describe('deployVersion overwrite gate', () => {
    let existingRows: Array<Record<string, unknown>>;
    const mockFor = jest.fn(async (..._args: unknown[]) => existingRows);
    const mockValues = jest.fn((..._args: unknown[]) => ({
      onConflictDoUpdate: jest.fn(() => ({ returning: jest.fn(async () => [{ id: 'p-1', orgId: 'org-1' }]) })),
    }));
    const mockUpdateSet = jest.fn((..._args: unknown[]) => ({ where: jest.fn<AnyFn>() }));
    const selectChain = () => {
      const where = jest.fn(() => Object.assign(Promise.resolve(existingRows), { for: mockFor }));
      return { from: () => ({ where }) };
    };
    const data = { orgId: 'org-1', name: 'my-plugin', version: '1.0.0', visibility: 'org' } as any;
    const member = { isSystemAdmin: false, canPublish: false };

    beforeEach(() => {
      existingRows = [];
      pipelineDataMock.withTenantTx.mockImplementation(async (cb: any) => cb({
        execute: jest.fn(async () => []),
        select: jest.fn(selectChain),
        update: jest.fn(() => ({ set: mockUpdateSet })),
        insert: jest.fn(() => ({ values: mockValues })),
      }));
    });

    it('deploys a brand-new version (no conflicting row) and locks the lookup', async () => {
      await service.deployVersion(data, 'user-1', member);
      expect(mockFor).toHaveBeenCalledWith('update');
      expect(mockValues).toHaveBeenCalled();
    });

    it('refuses to resurrect a soft-deleted version (409), even for a system admin', async () => {
      existingRows = [{ visibility: 'org', createdBy: 'user-1', deletedAt: new Date() }];
      await expect(service.deployVersion(data, 'user-1', { isSystemAdmin: true, canPublish: true }))
        .rejects.toMatchObject({ statusCode: 409 });
      expect(mockValues).not.toHaveBeenCalled();
      expect(mockUpdateSet).not.toHaveBeenCalled();
    });

    it("refuses to overwrite another author's PRIVATE version (409)", async () => {
      existingRows = [{ visibility: 'private', createdBy: 'user-A', deletedAt: null }];
      await expect(service.deployVersion(data, 'user-B', member)).rejects.toMatchObject({ statusCode: 409 });
      expect(mockValues).not.toHaveBeenCalled();
      expect(mockUpdateSet).not.toHaveBeenCalled();
    });

    it('refuses to overwrite a PUBLIC version without plugins:publish (403)', async () => {
      existingRows = [{ visibility: 'public', createdBy: 'user-A', deletedAt: null }];
      await expect(service.deployVersion(data, 'user-A', member)).rejects.toMatchObject({ statusCode: 403 });
      expect(mockValues).not.toHaveBeenCalled();
    });

    /** No row at the uploaded version; the name's current default is user-A's private 1.0.0. */
    const withPrivateDefault = () => {
      let call = 0;
      pipelineDataMock.withTenantTx.mockImplementation(async (cb: any) => cb({
        execute: jest.fn(async () => []),
        select: jest.fn(() => {
          const rows = call++ === 0 ? [] : [{ id: 'd-1', version: '1.0.0', visibility: 'private', createdBy: 'user-A', deletedAt: null }];
          return { from: () => ({ where: () => Object.assign(Promise.resolve(rows), { for: async () => rows }) }) };
        }),
        update: jest.fn(() => ({ set: mockUpdateSet })),
        insert: jest.fn(() => ({ values: mockValues })),
      }));
    };

    it("refuses to take the default away from another author's PRIVATE plugin (409)", async () => {
      withPrivateDefault();
      // A same-major release would take over the default, so it needs write access to user-A's row.
      await expect(service.deployVersion({ ...data, version: '1.1.0' }, 'user-B', member)).rejects.toMatchObject({ statusCode: 409 });
      expect(mockUpdateSet).not.toHaveBeenCalled();
      expect(mockValues).not.toHaveBeenCalled();
    });

    it('a new major never takes over the default, so it needs no access to the current default row', async () => {
      withPrivateDefault();
      await service.deployVersion({ ...data, version: '2.0.0' }, 'user-B', member);
      expect(mockUpdateSet).not.toHaveBeenCalled(); // the current default is untouched
      expect(mockValues).toHaveBeenCalledWith(expect.objectContaining({ version: '2.0.0', isDefault: false }));
    });

    it('a same-major patch release becomes the default and demotes the old one', async () => {
      let call = 0;
      pipelineDataMock.withTenantTx.mockImplementation(async (cb: any) => cb({
        execute: jest.fn(async () => []),
        select: jest.fn(() => {
          const rows = call++ === 0 ? [] : [{ id: 'd-1', version: '1.0.0', visibility: 'org', createdBy: 'user-A', deletedAt: null }];
          return { from: () => ({ where: () => Object.assign(Promise.resolve(rows), { for: async () => rows }) }) };
        }),
        update: jest.fn(() => ({ set: mockUpdateSet })),
        insert: jest.fn(() => ({ values: mockValues })),
      }));
      await service.deployVersion({ ...data, version: '1.0.1' }, 'user-B', member);
      expect(mockUpdateSet).toHaveBeenCalledWith(expect.objectContaining({ isDefault: false }));
      expect(mockValues).toHaveBeenCalledWith(expect.objectContaining({ version: '1.0.1', isDefault: true }));
    });

    it('invalidates and emits the entity event only AFTER the deploy transaction commits (created, then updated)', async () => {
      const order: string[] = [];
      const inner = pipelineDataMock.withTenantTx.getMockImplementation()!;
      pipelineDataMock.withTenantTx.mockImplementation(async (cb: any) => {
        const out = await (inner as any)(cb);
        order.push('commit');
        return out;
      });
      const invalidate = jest.spyOn(service as any, 'invalidateAndEmit');
      invalidate.mockImplementation(async (type: unknown) => { order.push(`event:${String(type)}`); });
      await service.deployVersion(data, 'user-1', member);
      existingRows = [{ version: '1.0.0', visibility: 'org', createdBy: 'user-1', deletedAt: null }];
      await service.deployVersion(data, 'user-1', member);
      expect(order).toEqual(['commit', 'event:created', 'commit', 'event:updated']);
    });

    it('drops every org\'s cached copy of the demoted default', async () => {
      let call = 0;
      pipelineDataMock.withTenantTx.mockImplementation(async (cb: any) => cb({
        execute: jest.fn(async () => []),
        select: jest.fn(() => {
          const rows = call++ === 0 ? [] : [{ id: 'd-1', version: '1.0.0', visibility: 'public', createdBy: 'user-A', deletedAt: null }];
          return { from: () => ({ where: () => Object.assign(Promise.resolve(rows), { for: async () => rows }) }) };
        }),
        update: jest.fn(() => ({ set: mockUpdateSet })),
        insert: jest.fn(() => ({ values: mockValues })),
      }));
      const ids = jest.spyOn(service as any, 'invalidateIds');
      await service.deployVersion({ ...data, version: '1.0.1' }, 'user-B', { isSystemAdmin: false, canPublish: true });
      expect(ids).toHaveBeenCalledWith(['d-1']);
    });

    it('allows the author (private), a publisher (public), a member (org), and a system admin', async () => {
      existingRows = [{ version: '1.0.0', visibility: 'private', createdBy: 'user-A', deletedAt: null }];
      await service.deployVersion(data, 'user-A', member);
      existingRows = [{ version: '1.0.0', visibility: 'public', createdBy: 'user-A', deletedAt: null }];
      await service.deployVersion(data, 'user-B', { isSystemAdmin: false, canPublish: true });
      existingRows = [{ version: '1.0.0', visibility: 'org', createdBy: 'user-A', deletedAt: null }];
      await service.deployVersion(data, 'user-B', member);
      existingRows = [{ version: '1.0.0', visibility: 'private', createdBy: 'user-A', deletedAt: null }];
      await service.deployVersion(data, 'admin', { isSystemAdmin: true, canPublish: false });
      expect(mockValues).toHaveBeenCalledTimes(4);
    });

    it('never un-deletes on the conflict branch (no deletedAt/deletedBy reset in the SET)', async () => {
      const onConflict = jest.fn(() => ({ returning: jest.fn(async () => [{ id: 'p-1', orgId: 'org-1' }]) }));
      mockValues.mockReturnValueOnce({ onConflictDoUpdate: onConflict });
      await service.deployVersion(data, 'user-1', member);
      const { set } = (onConflict.mock.calls[0] as any[])[0];
      expect(set).not.toHaveProperty('deletedAt');
      expect(set).not.toHaveProperty('deletedBy');
    });

    it('assertDeployable applies the same refusal up front (no lock, no write)', async () => {
      existingRows = [{ visibility: 'private', createdBy: 'user-A', deletedAt: null }];
      await expect(service.assertDeployable('org-1', 'my-plugin', '1.0.0', 'user-B', member))
        .rejects.toMatchObject({ statusCode: 409 });
      existingRows = [];
      await expect(service.assertDeployable('org-1', 'my-plugin', '1.0.0', 'user-B', member)).resolves.toBeUndefined();
      expect(mockFor).not.toHaveBeenCalled();
    });
  });

  // Promoting a version to default used to be a plain column write, leaving the
  // previous default set too (several "defaults" for one plugin name).
  describe('update — promoting a default (isDefault: true)', () => {
    type Op = { op: string; set?: any; where?: any };
    let ops: Op[];
    let txCount: number;
    let currentDefaults: Array<Record<string, unknown>>;
    const target = { name: 'my-plugin', orgId: 'org-1' };
    const promoted = { id: 'p-2', orgId: 'org-1', name: 'my-plugin', version: '2.0.0', isDefault: true };
    const member = { isSystemAdmin: false, canPublish: false };

    beforeEach(() => {
      ops = [];
      txCount = 0;
      currentDefaults = [{ visibility: 'org', createdBy: 'user-A', deletedAt: null }];
      pipelineDataMock.withTenantTx.mockImplementation(async (cb: any) => {
        txCount++;
        let selects = 0;
        return cb({
          execute: jest.fn(async () => { ops.push({ op: 'lock' }); return []; }),
          select: jest.fn(() => ({
            from: () => ({
              where: () => {
                const first = selects++ === 0;
                const rows = first ? [target] : currentDefaults;
                return Object.assign(Promise.resolve(rows), {
                  for: async (mode: string) => { ops.push({ op: `select-defaults-for-${mode}` }); return rows; },
                });
              },
            }),
          })),
          update: jest.fn(() => ({
            set: (set: any) => ({
              where: (where: any) => {
                ops.push({ op: 'update', set, where });
                return Object.assign(Promise.resolve([]), { returning: async () => [promoted] });
              },
            }),
          })),
        });
      });
    });

    it('clears the other defaults of the same (org, name) and promotes the row in ONE transaction', async () => {
      const result = await service.update('P-2', { isDefault: true, description: 'd' }, 'org-1', 'user-1', member);

      expect(result).toEqual(promoted);
      expect(txCount).toBe(1);
      expect(mockSuperUpdate).not.toHaveBeenCalled();
      const updates = ops.filter((o) => o.op === 'update');
      expect(updates).toHaveLength(2);
      // 1st: demote every OTHER live default of this name in the org …
      expect(updates[0].set).toMatchObject({ isDefault: false, updatedBy: 'user-1' });
      expect(updates[0].where).toEqual(expect.arrayContaining([
        { col: 'name', val: 'my-plugin', op: 'eq' },
        { col: 'orgId', val: 'org-1', op: 'eq' },
        { col: 'isDefault', val: true, op: 'eq' },
        { col: 'id', val: 'p-2', op: 'ne' },
      ]));
      // … 2nd: then write the promoted row itself.
      expect(updates[1].set).toMatchObject({ isDefault: true, description: 'd', updatedBy: 'user-1' });
      // Serialized with deployVersion on the same (org, name) advisory lock, before any write.
      expect(ops[0].op).toBe('lock');
    });

    it("refuses to demote another author's PRIVATE default (409) and writes nothing", async () => {
      currentDefaults = [{ visibility: 'private', createdBy: 'user-A', deletedAt: null }];
      await expect(service.update('p-2', { isDefault: true }, 'org-1', 'user-B', member))
        .rejects.toMatchObject({ statusCode: 409 });
      expect(ops.filter((o) => o.op === 'update')).toHaveLength(0);
    });

    it('defaults the caller authority to least privilege (a PUBLIC default needs plugins:publish)', async () => {
      currentDefaults = [{ visibility: 'public', createdBy: 'user-A', deletedAt: null }];
      await expect(service.update('p-2', { isDefault: true }, 'org-1', 'user-A'))
        .rejects.toMatchObject({ statusCode: 403 });
    });

    it('returns null (no writes) when the target is not visible/own-org', async () => {
      pipelineDataMock.withTenantTx.mockImplementation(async (cb: any) => cb({
        execute: jest.fn<AnyFn>(),
        select: jest.fn(() => ({ from: () => ({ where: () => Promise.resolve([]) }) })),
        update: jest.fn(() => { throw new Error('must not write'); }),
      }));
      await expect(service.update('p-9', { isDefault: true }, 'org-1', 'user-1', member)).resolves.toBeNull();
    });

    it('delegates a non-promoting update to the base CrudService.update', async () => {
      mockSuperUpdate.mockResolvedValue({ id: 'p-2' });
      await service.update('p-2', { description: 'x', isDefault: false }, 'org-1', 'user-1', member);
      expect(mockSuperUpdate).toHaveBeenCalledWith('p-2', { description: 'x', isDefault: false }, 'org-1', 'user-1');
      expect(txCount).toBe(0);
    });
  });

  // The base CrudService.updateMany fires no lifecycle hooks, so bulk update
  // skipped the cache invalidation + compliance event a single update gets.
  describe('updateMany — per-row post-update lifecycle', () => {
    const secretPluginBase = { orgId: 'org-1', name: 'my-plugin', version: '1.0.0', visibility: 'org', env: {}, buildArgs: {} };
    it("emits an 'updated' entity event for every changed row", async () => {
      const rows = [
        { ...secretPluginBase, id: 'p-1' },
        { ...secretPluginBase, id: 'p-2' },
      ];
      mockSuperUpdateMany.mockResolvedValue(rows);
      const captured: any[] = [];
      const subscriber = { onEntityEvent: async (e: any) => { captured.push(e); } };
      entityEvents.subscribe(subscriber);
      try {
        const result = await service.updateMany({ id: ['p-1', 'p-2'] } as any, { isActive: false }, 'org-1', 'user-1');
        expect(result).toBe(rows);
      } finally {
        entityEvents.unsubscribe(subscriber);
      }
      expect(mockSuperUpdateMany).toHaveBeenCalledWith({ id: ['p-1', 'p-2'] }, { isActive: false }, 'org-1', 'user-1');
      expect(captured.map((e) => [e.eventType, e.entityId])).toEqual([['updated', 'p-1'], ['updated', 'p-2']]);
    });

    it('invalidates the org plugin cache (via the shared update hook)', async () => {
      mockSuperUpdateMany.mockResolvedValue([{ ...secretPluginBase, id: 'p-1' }]);
      const spy = jest.spyOn(service as any, 'onAfterUpdate');
      await service.updateMany({ id: ['p-1'] } as any, { isActive: false }, 'org-1', 'user-1');
      expect(spy).toHaveBeenCalledWith('p-1', expect.objectContaining({ id: 'p-1' }), 'user-1');
    });
  });

  describe('getSortColumn', () => {
    it('should return a column for valid sortBy values', () => {
      const validFields = ['id', 'name', 'version', 'createdAt', 'updatedAt', 'isActive', 'isDefault'];

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

  // A plugin row whose env/buildArgs hold real secret VALUES. The compliance
  // event must carry the KEYS (compliance evaluates `$keys(env)`/`$count(env)`
  // and key-presence) but NEVER the plaintext values.
  const secretPlugin = {
    id: 'plugin-1',
    orgId: 'org-1',
    name: 'my-plugin',
    version: '1.2.3',
    visibility: 'private',
    computeType: 'SMALL',
    pluginType: 'CodeBuildStep',
    secrets: [{ name: 'NPM_TOKEN', required: true }],
    env: { AWS_ACCESS_KEY_ID: 'AKIA_SECRET', DEPLOY_TOKEN: 'SECRET123' },
    buildArgs: { REGISTRY_PASSWORD: 'BUILDSECRET456' },
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-02T00:00:00Z'),
  } as any;

  describe('compliance event emission — secret redaction', () => {
    it('emits env/buildArgs KEYS but never their secret VALUES', async () => {
      const captured: any[] = [];
      const subscriber = { onEntityEvent: async (e: any) => { captured.push(e); } };
      entityEvents.subscribe(subscriber);
      try {
        await (service as any).onAfterCreate(secretPlugin, 'user-1');
      } finally {
        entityEvents.unsubscribe(subscriber);
      }

      expect(captured).toHaveLength(1);
      const event = captured[0];
      // Event envelope is unchanged (type/target/id/org/user).
      expect(event.eventType).toBe('created');
      expect(event.target).toBe('plugin');
      expect(event.entityId).toBe('plugin-1');
      expect(event.orgId).toBe('org-1');

      // No secret VALUE anywhere in the serialized payload.
      const serialized = JSON.stringify(event.attributes);
      expect(serialized).not.toContain('SECRET123');
      expect(serialized).not.toContain('BUILDSECRET456');
      expect(serialized).not.toContain('AKIA_SECRET');

      // But compliance-relevant metadata + the secret KEYS are present.
      expect(event.attributes.name).toBe('my-plugin');
      expect(event.attributes.version).toBe('1.2.3');
      expect(event.attributes.visibility).toBe('private');
      expect(Object.keys(event.attributes.env)).toEqual(['AWS_ACCESS_KEY_ID', 'DEPLOY_TOKEN']);
      expect(Object.keys(event.attributes.buildArgs)).toEqual(['REGISTRY_PASSWORD']);
      // secrets[] declarations (names only) survive — compliance uses $count(secrets).
      expect(event.attributes.secrets).toEqual([{ name: 'NPM_TOKEN', required: true }]);
    });
  });

  describe('toComplianceAttributes', () => {
    it('preserves keys, redacts values, and leaves Dates/metadata intact', () => {
      const projected: any = toComplianceAttributes(secretPlugin);
      expect(projected.env).toEqual({ AWS_ACCESS_KEY_ID: '[REDACTED]', DEPLOY_TOKEN: '[REDACTED]' });
      expect(projected.buildArgs).toEqual({ REGISTRY_PASSWORD: '[REDACTED]' });
      // Dates must not be corrupted into {} by the recursive walk.
      expect(projected.createdAt).toBeInstanceOf(Date);
      expect(projected.name).toBe('my-plugin');
    });
  });


  // ---------------------------------------------------------------------------
  // — resolution order, delete safety, lifecycle
  // ---------------------------------------------------------------------------

  describe('findFirstOrderBy — the shared lookup ranking', () => {
    it('delegates to pluginResolutionOrderBy with the caller org and parent org', () => {
      const order = (service as any).findFirstOrderBy({}, 'org-1', 'parent-1');
      expect(mockPluginResolutionOrderBy).toHaveBeenCalledWith('org-1', 'parent-1');
      expect(order).toEqual(['resolution-order']);
    });
  });

  describe('deleteVersion — delete safety', () => {
    const row = { id: 'p-1', orgId: 'org-1', name: 'trivy', version: '1.0.0', isDefault: false, frozenAt: null, quotaResetAt: null } as any;
    let deleteSpy: jest.Mock<(...a: any[]) => Promise<any>>;

    beforeEach(() => {
      deleteSpy = jest.fn<(...a: any[]) => Promise<any>>(async () => row);
      (service as any).delete = deleteSpy;
      jest.spyOn(service, 'promoteNextDefault').mockResolvedValue(null);
      jest.spyOn(service, 'clearQuotaSnapshot').mockResolvedValue(undefined);
    });

    const blockers = (reason: 'frozen' | 'listed' | null, inUse: number) => {
      jest.spyOn(service, 'versionImmutability').mockResolvedValue(reason);
      jest.spyOn(service, 'countPipelinesUsing').mockResolvedValue(inUse);
    };

    it('deletes an unused, unlisted version', async () => {
      blockers(null, 0);
      await expect(service.deleteVersion(row, 'org-1', 'u-1', { force: false }))
        .resolves.toEqual({ deleted: row, inUse: 0, listed: false, promoted: null });
      expect(deleteSpy).toHaveBeenCalledWith('p-1', 'org-1', 'u-1');
      expect(service.clearQuotaSnapshot).not.toHaveBeenCalled();
    });

    it('never deletes a version a pending publish request references, even with force', async () => {
      blockers('frozen', 0);
      await expect(service.deleteVersion(row, 'org-1', 'u-1', { force: true }))
        .rejects.toMatchObject({ statusCode: 409, code: 'PLUGIN_VERSION_FROZEN' });
      expect(deleteSpy).not.toHaveBeenCalled();
    });

    it.each([
      [null, 2, /used by 2 pipelines/],
      ['listed', 0, /published to the ecosystem/],
      ['listed', 1, /used by 1 pipeline and published to the ecosystem/],
    ] as const)('refuses (reason=%s, inUse=%d) without force with 409 PLUGIN_VERSION_IN_USE', async (reason, inUse, message) => {
      blockers(reason, inUse);
      await expect(service.deleteVersion(row, 'org-1', 'u-1', { force: false }))
        .rejects.toMatchObject({ statusCode: 409, code: 'PLUGIN_VERSION_IN_USE', message: expect.stringMatching(message) });
      expect(deleteSpy).not.toHaveBeenCalled();
    });

    it('deletes an in-use, listed version with force, clears its quota snapshot and promotes the next default', async () => {
      blockers('listed', 3);
      const promoted = { id: 'p-0', version: '0.9.0' };
      (service.promoteNextDefault as jest.Mock<(...a: any[]) => Promise<any>>).mockResolvedValue(promoted);
      const def = { ...row, isDefault: true, quotaResetAt: new Date() };
      await expect(service.deleteVersion(def, 'org-1', 'u-1', { force: true }))
        .resolves.toEqual({ deleted: row, inUse: 3, listed: true, promoted });
      expect(service.clearQuotaSnapshot).toHaveBeenCalledWith('p-1');
      expect(service.promoteNextDefault).toHaveBeenCalledWith('org-1', def, 'u-1');
    });

    it('does nothing more when the delete matched no row', async () => {
      blockers(null, 0);
      deleteSpy.mockResolvedValueOnce(null);
      const res = await service.deleteVersion({ ...row, isDefault: true, quotaResetAt: new Date() }, 'org-1', 'u-1', { force: false });
      expect(res.deleted).toBeNull();
      expect(service.clearQuotaSnapshot).not.toHaveBeenCalled();
      expect(service.promoteNextDefault).not.toHaveBeenCalled();
    });

    it('deleteBlockers reports frozen / listed / inUse', async () => {
      blockers('listed', 4);
      await expect(service.deleteBlockers(row, 'org-1')).resolves.toEqual({ frozen: false, listed: true, inUse: 4 });
      blockers('frozen', 0);
      await expect(service.deleteBlockers(row, 'org-1')).resolves.toEqual({ frozen: true, listed: false, inUse: 0 });
    });
  });

  describe('versionImmutability / countPipelinesUsing / clearQuotaSnapshot (tx-level)', () => {
    const txWith = (tx: Record<string, unknown>) => pipelineDataMock.withTenantTx.mockImplementation(async (cb: any) => cb(tx));

    it('is frozen when frozen_at is set, listed when a listing version came from it, else null', async () => {
      await expect(service.versionImmutability({ id: 'p-1', frozenAt: new Date() })).resolves.toBe('frozen');
      txWith({ execute: jest.fn(async () => ({ rows: [{ '?column?': 1 }] })) });
      await expect(service.versionImmutability({ id: 'p-1', frozenAt: null })).resolves.toBe('listed');
      txWith({ execute: jest.fn(async () => ({ rows: [] })) });
      await expect(service.versionImmutability({ id: 'p-1', frozenAt: null })).resolves.toBeNull();
    });

    it('counts pipelines whose reference resolves to this version (range, exact, or default when unversioned)', async () => {
      txWith({
        execute: jest.fn(async () => ({
          rows: [
            { spec: '^1.0.0', cnt: '2' }, // satisfied by 1.2.0
            { spec: '2.0.0', cnt: 5 }, // another version
            { spec: null, cnt: '3' }, // unversioned → the default
          ],
        })),
      });
      await expect(service.countPipelinesUsing('org-1', { name: 'trivy', version: '1.2.0', isDefault: true })).resolves.toBe(5);
      await expect(service.countPipelinesUsing('org-1', { name: 'trivy', version: '1.2.0', isDefault: false })).resolves.toBe(2);
    });

    describe('findOrgsUsingVersion (N14 recipients)', () => {
      const run = (defRows: any[], deployedRows: any[]) => {
        const where = jest.fn(async () => deployedRows);
        const selectDistinct = jest.fn(() => ({ from: () => ({ where }) }));
        txWith({ execute: jest.fn(async () => ({ rows: defRows })), selectDistinct });
        return { where, selectDistinct };
      };
      /** Every SQL fragment the last call built, flattened to text. */
      const sqlText = () => mockSql.mock.calls.map((c: any[]) => (Array.isArray(c[0]) ? c[0].join('?') : '')).join('\n');

      it('unions definition users whose spec resolves to the version with deployed manifest users', async () => {
        run(
          [
            { org_id: 'org-1', spec: '^1.0.0' }, // satisfied
            { org_id: 'org-2', spec: '2.0.0' }, // another version
            { org_id: 'ORG-3', spec: null }, // unversioned → default
          ],
          [{ orgId: 'team-9' }, { orgId: 'org-1' }],
        );
        const orgs = await service.findOrgsUsingVersion({ orgId: 'org-1', name: 'trivy', version: '1.2.0', isDefault: true, visibility: 'public' });
        expect(orgs).toEqual(['org-1', 'org-3', 'team-9']);
      });

      it('skips unversioned references when the version is not the default', async () => {
        run([{ org_id: 'org-1', spec: null }], []);
        await expect(service.findOrgsUsingVersion({ orgId: 'org-1', name: 'trivy', version: '1.2.0', isDefault: false, visibility: 'org' }))
          .resolves.toEqual([]);
      });

      it('scopes definitions to the owner org for a tenant plugin, and matches its manifest by image repository', async () => {
        mockSql.mockClear();
        const { where } = run([], []);
        await service.findOrgsUsingVersion({ orgId: 'org-1', name: 'trivy', version: '1.2.0', isDefault: true, visibility: 'public' });
        const text = sqlText();
        expect(text).toContain('AND p.org_id = ?');
        expect(text).not.toContain('NOT EXISTS');
        expect(text).toContain('IS NULL AND');
        expect(mockSql.mock.calls.some((c: any[]) => c.includes('org-org-1/trivy'))).toBe(true);
        expect(where).toHaveBeenCalled();
      });

      it('never reaches other orgs through a public system-org row (Official plugins reach them as listings)', async () => {
        mockSql.mockClear();
        run([], []);
        await service.findOrgsUsingVersion({ orgId: SYSTEM_ORG_ID, name: 'trivy', version: '1.2.0', isDefault: true, visibility: 'public' });
        const text = sqlText();
        expect(text).toContain('AND p.org_id = ?');
        expect(text).not.toContain('NOT EXISTS');
        expect(mockInstallingOrgs).not.toHaveBeenCalled();
      });

      it('adds the installing orgs of every listing version published from the row', async () => {
        run([{ org_id: 'org-1', spec: null }], []);
        mockVersionsBySource.mockResolvedValueOnce([{ listingId: 'l-1', version: '1.2.0' }, { listingId: 'l-gone', version: '1.2.0' }]);
        mockListingById.mockImplementation(async (id: string) => (id === 'l-1' ? { id: 'l-1', name: 'trivy', state: 'listed', publisherId: 'pub-1' } : null));
        mockPublisherById.mockResolvedValue({ id: 'pub-1', handle: 'acme', tier: 'verified', suspendedAt: null });
        mockInstallingOrgs.mockResolvedValueOnce([{ orgId: 'org-9', install: null }, { orgId: 'org-1', install: null }]);
        const orgs = await service.findOrgsUsingVersion({ id: 'p-1', orgId: 'org-1', name: 'trivy', version: '1.2.0', isDefault: true, visibility: 'public' });
        expect(orgs).toEqual(['org-1', 'org-9']);
        expect(mockVersionsBySource).toHaveBeenCalledWith(['p-1']);
        expect(mockInstallingOrgs).toHaveBeenCalledWith(expect.objectContaining({ handle: 'acme' }), expect.objectContaining({ id: 'l-1' }), '1.2.0');
      });

      it('matches an image-less tenant plugin\'s manifest by owner org only', async () => {
        mockSql.mockClear();
        run([], []);
        await service.findOrgsUsingVersion({ orgId: 'org-1', name: 'meta', version: '1.0.0', isDefault: true, visibility: 'org', buildType: 'metadata_only' });
        expect(mockSql.mock.calls.some((c: any[]) => c.includes('org-org-1/meta'))).toBe(false);
      });

      it('accepts a driver that returns a bare row array', async () => {
        const where = jest.fn(async () => []);
        txWith({ execute: jest.fn(async () => [{ org_id: 'org-1', spec: '1.2.0' }]), selectDistinct: jest.fn(() => ({ from: () => ({ where }) })) });
        await expect(service.findOrgsUsingVersion({ orgId: 'org-1', name: 'trivy', version: '1.2.0', isDefault: false, visibility: 'org' }))
          .resolves.toEqual(['org-1']);
      });
    });

    it('clearQuotaSnapshot nulls quota_reset_at on the row', async () => {
      const set = jest.fn((..._args: unknown[]) => ({ where: jest.fn(async () => undefined) }));
      txWith({ update: jest.fn(() => ({ set })) });
      await service.clearQuotaSnapshot('p-1');
      expect(set).toHaveBeenCalledWith({ quotaResetAt: null });
    });
  });

  describe('setDeprecated', () => {
    const captureSet = () => {
      const set = jest.fn((_v: any) => ({ where: jest.fn(() => ({ returning: jest.fn(async () => [{ id: 'p-1', orgId: 'org-1' }]) })) }));
      pipelineDataMock.withTenantTx.mockImplementation(async (cb: any) => cb({ update: jest.fn(() => ({ set })) }));
      return set;
    };
    const row = { id: 'p-1', orgId: 'org-1', lifecycle: 'production', yankedAt: null, deprecatedAt: null } as any;

    it('stamps deprecatedAt + message and mirrors lifecycle', async () => {
      const set = captureSet();
      await expect(service.setDeprecated(row, 'org-1', 'u-1', { deprecated: true, message: 'Use 2.x' })).resolves.toMatchObject({ id: 'p-1' });
      expect(set.mock.calls[0]![0]).toMatchObject({ deprecatedAt: expect.any(Date), deprecationMessage: 'Use 2.x', lifecycle: 'deprecated', updatedBy: 'u-1' });
    });

    it('keeps the original deprecatedAt on a repeat and never overwrites a yanked lifecycle', async () => {
      const set = captureSet();
      const when = new Date('2026-01-01');
      await service.setDeprecated({ ...row, deprecatedAt: when, lifecycle: 'yanked', yankedAt: when }, 'org-1', 'u-1', { deprecated: true });
      expect(set.mock.calls[0]![0].deprecatedAt).toBe(when);
      expect(set.mock.calls[0]![0]).not.toHaveProperty('lifecycle');
    });

    it('clears the deprecation and restores production', async () => {
      const set = captureSet();
      await service.setDeprecated({ ...row, lifecycle: 'deprecated', deprecatedAt: new Date() }, 'org-1', 'u-1', { deprecated: false });
      expect(set.mock.calls[0]![0]).toMatchObject({ deprecatedAt: null, deprecationMessage: null, lifecycle: 'production' });
    });

    it('returns null when nothing matched', async () => {
      pipelineDataMock.withTenantTx.mockImplementation(async (cb: any) => cb({
        update: jest.fn(() => ({ set: () => ({ where: () => ({ returning: async () => [] }) }) })),
      }));
      await expect(service.setDeprecated(row, 'org-1', 'u-1', { deprecated: true })).resolves.toBeNull();
    });
  });

  describe('yankVersion / promoteNextDefault', () => {
    it('refuses to yank a version published to the ecosystem', async () => {
      pipelineDataMock.withTenantTx.mockImplementation(async (cb: any) => cb({ execute: jest.fn(async () => ({ rows: [{ x: 1 }] })) }));
      await expect(service.yankVersion({ id: 'p-1', isDefault: false } as any, 'org-1', 'u-1', 'why'))
        .rejects.toMatchObject({ statusCode: 409, code: 'PLUGIN_VERSION_FROZEN' });
    });

    it('yanks (clearing default) and promotes the next default when it was the default', async () => {
      const set = jest.fn((_v: any) => ({ where: jest.fn(() => ({ returning: jest.fn(async () => [{ id: 'p-1', orgId: 'org-1' }]) })) }));
      pipelineDataMock.withTenantTx.mockImplementation(async (cb: any) => cb({ execute: jest.fn(async () => ({ rows: [] })), update: jest.fn(() => ({ set })) }));
      const promote = jest.spyOn(service, 'promoteNextDefault').mockResolvedValue({ id: 'p-0' } as any);
      const res = await service.yankVersion({ id: 'p-1', name: 'trivy', version: '1.0.0', isDefault: true } as any, 'org-1', 'u-1', 'CVE');
      expect(set.mock.calls[0]![0]).toMatchObject({ lifecycle: 'yanked', yankReason: 'CVE', isDefault: false, yankedAt: expect.any(Date) });
      expect(res).toEqual({ yanked: { id: 'p-1', orgId: 'org-1' }, promoted: { id: 'p-0' } });
      expect(promote).toHaveBeenCalled();
    });

    const promoteTx = (liveDefaults: unknown[], candidates: Array<{ id: string; version: string }>) => {
      const set = jest.fn((_v: any) => ({ where: jest.fn(() => ({ returning: jest.fn(async () => [{ id: 'picked', orgId: 'org-1' }]) })) }));
      pipelineDataMock.withTenantTx.mockImplementation(async (cb: any) => cb({
        execute: jest.fn(async () => []),
        select: jest.fn(() => ({ from: () => ({ where: () => Object.assign(Promise.resolve(liveDefaults), { orderBy: async () => candidates }) }) })),
        update: jest.fn(() => ({ set })),
      }));
      return set;
    };

    it('promotes the highest stable version not above the removed major', async () => {
      const set = promoteTx([], [
        { id: 'v3', version: '3.0.0' }, { id: 'v2rc', version: '2.1.0-rc.1' }, { id: 'v2', version: '2.0.5' }, { id: 'v1', version: '1.9.0' },
      ]);
      await expect(service.promoteNextDefault('org-1', { name: 'trivy', version: '2.3.0' }, 'u-1')).resolves.toMatchObject({ id: 'picked' });
      expect(set).toHaveBeenCalledWith(expect.objectContaining({ isDefault: true }));
    });

    it('is a no-op when a default exists again or no candidate qualifies', async () => {
      const set = promoteTx([{ id: 'd' }], [{ id: 'v1', version: '1.0.0' }]);
      await expect(service.promoteNextDefault('org-1', { name: 'trivy', version: '1.0.0' }, 'u-1')).resolves.toBeNull();
      const set2 = promoteTx([], [{ id: 'v3', version: '3.0.0' }, { id: 'pre', version: '1.0.0-beta' }]);
      await expect(service.promoteNextDefault('org-1', { name: 'trivy', version: '2.0.0' }, 'u-1')).resolves.toBeNull();
      expect(set).not.toHaveBeenCalled();
      expect(set2).not.toHaveBeenCalled();
    });
  });

  describe('deployVersion — catalog metadata on re-upload', () => {
    it('replaces summary / displayName / documentationUrl / provenance / quota snapshot on the conflict branch', async () => {
      const onConflict = jest.fn(() => ({ returning: jest.fn(async () => [{ id: 'p-1', orgId: 'org-1' }]) }));
      pipelineDataMock.withTenantTx.mockImplementation(async (cb: any) => cb({
        execute: jest.fn(async () => []),
        select: jest.fn(() => ({ from: () => ({ where: () => Object.assign(Promise.resolve([]), { for: async () => [] }) }) })),
        update: jest.fn(() => ({ set: jest.fn((..._args: unknown[]) => ({ where: jest.fn<AnyFn>() })) })),
        insert: jest.fn(() => ({ values: () => ({ onConflictDoUpdate: onConflict }) })),
      }));
      const quotaResetAt = new Date('2026-09-24T00:00:00Z');
      await service.deployVersion({
        orgId: 'org-1',
        name: 'p',
        version: '1.0.0',
        visibility: 'org',
        summary: 'S',
        displayName: 'D',
        documentationUrl: 'https://docs',
        metadataSources: { summary: 'user' },
        quotaResetAt,
      } as any, 'u-1', { isSystemAdmin: false, canPublish: false });
      const { set } = (onConflict.mock.calls[0] as any[])[0];
      expect(set).toMatchObject({ summary: 'S', displayName: 'D', documentationUrl: 'https://docs', metadataSources: { summary: 'user' }, quotaResetAt });
    });
  });
});
