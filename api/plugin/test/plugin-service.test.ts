// ---------------------------------------------------------------------------
// Mock external dependencies — must be set up before importing the service
// ---------------------------------------------------------------------------
jest.mock('@mwashburn160/pipeline-core', () => {
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
    buildPluginConditions: jest.fn(() => []),
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

jest.mock('drizzle-orm', () => ({
  SQL: class {},
  or: jest.fn((...args: any[]) => args),
  ilike: jest.fn((col: any, val: any) => ({ col, val, op: 'ilike' })),
  eq: jest.fn((col: any, val: any) => ({ col, val, op: 'eq' })),
}));

jest.mock('drizzle-orm/column', () => ({}));
jest.mock('drizzle-orm/pg-core', () => ({}));

import { PluginService } from '../src/services/plugin-service';

// Retrieve mock functions from the hoisted mock
const { __mockFind: mockFind, __mockSetDefault: mockSetDefault } =
  jest.requireMock('@mwashburn160/pipeline-core');

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PluginService', () => {
  let service: PluginService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new PluginService();
  });

  describe('findByName', () => {
    it('should call find with name and isActive filter', async () => {
      const expected = [{ id: '1', name: 'my-plugin' }];
      mockFind.mockResolvedValueOnce(expected);

      const result = await service.findByName('my-plugin', 'org-1');

      expect(mockFind).toHaveBeenCalledWith(
        { name: 'my-plugin', isActive: true },
        'org-1',
      );
      expect(result).toEqual(expected);
    });

    it('should return empty array when no plugins found', async () => {
      mockFind.mockResolvedValueOnce([]);

      const result = await service.findByName('nonexistent', 'org-1');
      expect(result).toEqual([]);
    });
  });

  describe('findByNameAndVersion', () => {
    it('should return the first matching plugin', async () => {
      const plugin = { id: '1', name: 'test', version: '1.0.0' };
      mockFind.mockResolvedValueOnce([plugin]);

      const result = await service.findByNameAndVersion('test', '1.0.0', 'org-1');

      expect(mockFind).toHaveBeenCalledWith(
        { name: 'test', version: '1.0.0', isActive: true },
        'org-1',
      );
      expect(result).toEqual(plugin);
    });

    it('should return null when no matching plugin found', async () => {
      mockFind.mockResolvedValueOnce([]);

      const result = await service.findByNameAndVersion('test', '9.9.9', 'org-1');
      expect(result).toBeNull();
    });
  });

  describe('getDefaultForOrg', () => {
    it('should return default active plugin for org', async () => {
      const plugin = { id: '1', orgId: 'org-1', isDefault: true, isActive: true };
      mockFind.mockResolvedValueOnce([plugin]);

      const result = await service.getDefaultForOrg('org-1');

      expect(mockFind).toHaveBeenCalledWith(
        { orgId: 'org-1', isDefault: true, isActive: true },
        'org-1',
      );
      expect(result).toEqual(plugin);
    });

    it('should return null when no default plugin exists', async () => {
      mockFind.mockResolvedValueOnce([]);

      const result = await service.getDefaultForOrg('org-1');
      expect(result).toBeNull();
    });
  });

  describe('setDefaultForOrg', () => {
    it('should call setDefault with orgId for both project and org fields', async () => {
      const updated = { id: 'plugin-1', isDefault: true };
      mockSetDefault.mockResolvedValueOnce(updated);

      const result = await service.setDefaultForOrg('org-1', 'plugin-1', 'user-1');

      expect(mockSetDefault).toHaveBeenCalledWith(
        'orgId', 'orgId', 'org-1', 'org-1', 'plugin-1', 'user-1',
      );
      expect(result).toEqual(updated);
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

  describe('buildSearchConditions', () => {
    it('should return search and access control conditions', () => {
      const conditions = (service as any).buildSearchConditions('test-query', 'org-1');

      expect(conditions).toHaveLength(2);
    });
  });
});
