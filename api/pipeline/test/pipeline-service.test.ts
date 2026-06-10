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

jest.unstable_mockModule('drizzle-orm', () => ({
  SQL: class {},
  sql: jest.fn((strings: TemplateStringsArray, ...values: any[]) => ({ strings, values, type: 'sql' })),
  or: jest.fn((...args: any[]) => args),
  ilike: jest.fn((col: any, val: any) => ({ col, val, op: 'ilike' })),
  eq: jest.fn((col: any, val: any) => ({ col, val, op: 'eq' })),
  and: jest.fn((...args: any[]) => args),
}));

jest.unstable_mockModule('drizzle-orm/column', () => ({}));
jest.unstable_mockModule('drizzle-orm/pg-core', () => ({}));

const { PipelineService } = await import('../src/services/pipeline-service.js');
const pipelineCoreMock = await import('@pipeline-builder/pipeline-core');

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
      const { withTenantTx } = pipelineCoreMock as unknown as { withTenantTx: jest.Mock };
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

});
