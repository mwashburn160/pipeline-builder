// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

// Mock external dependencies — must be set up before importing the service
import { jest, describe, it, expect, beforeEach } from '@jest/globals';

const mockTransactionSet = jest.fn().mockReturnValue({ where: jest.fn() });
const mockTransactionOnConflict = jest.fn().mockReturnValue({
  returning: jest.fn().mockResolvedValue([{ id: 'new-pipeline', isDefault: true }]),
});
const mockTransactionValues = jest.fn().mockReturnValue({
  onConflictDoUpdate: mockTransactionOnConflict,
});

jest.unstable_mockModule('@pipeline-builder/pipeline-core', () => {
  const mockFind = jest.fn();
  const mockSetDefault = jest.fn();

  class MockCrudService {
    find = mockFind;
    setDefault = mockSetDefault;
  }

  return {
    __mockFind: mockFind,
    __mockSetDefault: mockSetDefault,
    CrudService: MockCrudService,
    CoreConstants: { CACHE_TTL_ENTITY: 60 },
    buildPipelineConditions: jest.fn(() => []),
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
        accessModifier: 'accessModifier',
      },
    },
    // pipeline-service.createAsDefault was migrated from db.transaction to
    // withTenantTx — same tx shape, just routed through the tenancy seam.
    withTenantTx: jest.fn(async (cb: Function) => {
      const tx = {
        execute: jest.fn().mockResolvedValue([]),
        update: jest.fn().mockReturnValue({ set: mockTransactionSet }),
        insert: jest.fn().mockReturnValue({ values: mockTransactionValues }),
      };
      return cb(tx);
    }),
  };
});
jest.unstable_mockModule('@pipeline-builder/pipeline-data', () => {
  const mockFind = jest.fn();
  const mockSetDefault = jest.fn();

  class MockCrudService {
    find = mockFind;
    setDefault = mockSetDefault;
  }

  return {
    __mockFind: mockFind,
    __mockSetDefault: mockSetDefault,
    CrudService: MockCrudService,
    CoreConstants: { CACHE_TTL_ENTITY: 60 },
    buildPipelineConditions: jest.fn(() => []),
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
        accessModifier: 'accessModifier',
      },
    },
    // pipeline-service.createAsDefault was migrated from db.transaction to
    // withTenantTx — same tx shape, just routed through the tenancy seam.
    withTenantTx: jest.fn(async (cb: Function) => {
      const tx = {
        execute: jest.fn().mockResolvedValue([]),
        update: jest.fn().mockReturnValue({ set: mockTransactionSet }),
        insert: jest.fn().mockReturnValue({ values: mockTransactionValues }),
      };
      return cb(tx);
    }),
  };
});;

jest.unstable_mockModule('drizzle-orm', () => ({
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

const { PipelineService, toComplianceAttributes } = await import('../src/services/pipeline-service.js');
const pipelineDataMock = await import('@pipeline-builder/pipeline-data');
// api-core is NOT mocked — use the real in-process event emitter to capture the
// event the service emits to the compliance subscriber.
const { entityEvents } = await import('@pipeline-builder/api-core');

// Tests

describe('PipelineService', () => {
  let service: InstanceType<typeof PipelineService>;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new PipelineService();
  });

  describe('createAsDefault', () => {
    it('should clear existing defaults and create new pipeline in a transaction', async () => {
      const data = { orgId: 'org-1', project: 'proj', organization: 'org' } as any;

      const result = await service.createAsDefault(data, 'user-1', 'proj', 'org');

      // Verify the tenancy-aware transaction wrapper was used.
      const { withTenantTx } = pipelineDataMock as unknown as { withTenantTx: jest.Mock };
      expect(withTenantTx).toHaveBeenCalled();

      // Verify update was called to clear defaults
      expect(mockTransactionSet).toHaveBeenCalledWith(
        expect.objectContaining({ isDefault: false }),
      );

      // Verify insert was called with isDefault: true
      expect(mockTransactionValues).toHaveBeenCalledWith(
        expect.objectContaining({ isDefault: true, isActive: true }),
      );

      expect(result).toEqual({ id: 'new-pipeline', isDefault: true });
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
    accessModifier: 'private',
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
