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
    withTenantTx: jest.fn(),
    AccessModifier: {},
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
        accessModifier: 'accessModifier',
      },
    },
  };
});

jest.unstable_mockModule('drizzle-orm', () => ({
  SQL: class {},
  sql: Object.assign((..._a: any[]) => ({}), { raw: (..._a: any[]) => ({}) }),
  and: jest.fn((...args: any[]) => args),
  or: jest.fn((...args: any[]) => args),
  ilike: jest.fn((col: any, val: any) => ({ col, val, op: 'ilike' })),
  eq: jest.fn((col: any, val: any) => ({ col, val, op: 'eq' })),
}));

jest.unstable_mockModule('drizzle-orm/column', () => ({}));
jest.unstable_mockModule('drizzle-orm/pg-core', () => ({}));

const { PluginService } = await import('../src/services/plugin-service.js');

// Tests

describe('PluginService', () => {
  let service: InstanceType<typeof PluginService>;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new PluginService();
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

});
