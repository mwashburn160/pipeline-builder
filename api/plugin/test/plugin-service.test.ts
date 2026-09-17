// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { jest, describe, it, expect, beforeEach } from '@jest/globals';

// Mock external dependencies — must be set up before importing the service
const mockFind = jest.fn();
const mockSetDefault = jest.fn();

jest.unstable_mockModule('@pipeline-builder/pipeline-core', () => {
  class MockCrudService {
    find = mockFind;
    setDefault = mockSetDefault;
  }

  return {
    __mockFind: mockFind,
    __mockSetDefault: mockSetDefault,
    CrudService: MockCrudService,
    CoreConstants: { CACHE_TTL_ENTITY: 60 },
    buildPluginConditions: jest.fn(() => []),
    getTenantContext: jest.fn(() => undefined),
    withTenantTx: jest.fn(),
    ComputeType: {},
    PluginType: {},
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
    },
  };
});
jest.unstable_mockModule('@pipeline-builder/pipeline-data', () => {
  class MockCrudService {
    find = mockFind;
    setDefault = mockSetDefault;
  }

  return {
    __mockFind: mockFind,
    __mockSetDefault: mockSetDefault,
    CrudService: MockCrudService,
    CoreConstants: { CACHE_TTL_ENTITY: 60 },
    buildPluginConditions: jest.fn(() => []),
    getTenantContext: jest.fn(() => undefined),
    withTenantTx: jest.fn(),
    ComputeType: {},
    PluginType: {},
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
    },
  };
});;

jest.unstable_mockModule('drizzle-orm', () => ({
  SQL: class {},
  sql: Object.assign((..._a: any[]) => ({}), { raw: (..._a: any[]) => ({}) }),
  and: jest.fn((...args: any[]) => args),
  or: jest.fn((...args: any[]) => args),
  ilike: jest.fn((col: any, val: any) => ({ col, val, op: 'ilike' })),
  eq: jest.fn((col: any, val: any) => ({ col, val, op: 'eq' })),
  isNull: jest.fn((col: any) => ({ col, op: 'isNull' })),
  inArray: jest.fn((col: any, vals: any[]) => ({ col, vals, op: 'inArray' })),
}));

jest.unstable_mockModule('drizzle-orm/column', () => ({}));
jest.unstable_mockModule('drizzle-orm/pg-core', () => ({}));

const { PluginService, toComplianceAttributes } = await import('../src/services/plugin-service.js');
const pipelineDataMock = await import('@pipeline-builder/pipeline-data') as unknown as { withTenantTx: jest.Mock };
// api-core is NOT mocked — use the real in-process event emitter to capture the
// event the service emits to the compliance subscriber.
const { entityEvents } = await import('@pipeline-builder/api-core');

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
    const mockFor = jest.fn(async () => existingRows);
    const mockValues = jest.fn(() => ({
      onConflictDoUpdate: jest.fn(() => ({ returning: jest.fn(async () => [{ id: 'p-1', orgId: 'org-1' }]) })),
    }));
    const mockUpdateSet = jest.fn(() => ({ where: jest.fn() }));
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

    it("refuses to take the default away from another author's PRIVATE plugin (409)", async () => {
      // No row at this version, but the current default of the name is user-A's private plugin.
      let call = 0;
      pipelineDataMock.withTenantTx.mockImplementation(async (cb: any) => cb({
        execute: jest.fn(async () => []),
        select: jest.fn(() => {
          const rows = call++ === 0 ? [] : [{ visibility: 'private', createdBy: 'user-A', deletedAt: null }];
          return { from: () => ({ where: () => Object.assign(Promise.resolve(rows), { for: async () => rows }) }) };
        }),
        update: jest.fn(() => ({ set: mockUpdateSet })),
        insert: jest.fn(() => ({ values: mockValues })),
      }));

      await expect(service.deployVersion({ ...data, version: '2.0.0' }, 'user-B', member)).rejects.toMatchObject({ statusCode: 409 });
      expect(mockUpdateSet).not.toHaveBeenCalled();
      expect(mockValues).not.toHaveBeenCalled();
    });

    it('allows the author (private), a publisher (public), a member (org), and a system admin', async () => {
      existingRows = [{ visibility: 'private', createdBy: 'user-A', deletedAt: null }];
      await service.deployVersion(data, 'user-A', member);
      existingRows = [{ visibility: 'public', createdBy: 'user-A', deletedAt: null }];
      await service.deployVersion(data, 'user-B', { isSystemAdmin: false, canPublish: true });
      existingRows = [{ visibility: 'org', createdBy: 'user-A', deletedAt: null }];
      await service.deployVersion(data, 'user-B', member);
      existingRows = [{ visibility: 'private', createdBy: 'user-A', deletedAt: null }];
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

});
