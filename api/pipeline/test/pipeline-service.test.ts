// ---------------------------------------------------------------------------
// Mock external dependencies — must be set up before importing the service
// ---------------------------------------------------------------------------
const mockTransactionSet = jest.fn().mockReturnValue({ where: jest.fn() });
const mockTransactionValues = jest.fn().mockReturnValue({
  returning: jest.fn().mockResolvedValue([{ id: 'new-pipeline', isDefault: true }]),
});

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
    db: {
      transaction: jest.fn(async (cb: Function) => {
        const tx = {
          update: jest.fn().mockReturnValue({ set: mockTransactionSet }),
          insert: jest.fn().mockReturnValue({ values: mockTransactionValues }),
        };
        return cb(tx);
      }),
    },
  };
});

jest.mock('drizzle-orm', () => ({
  SQL: class {},
  or: jest.fn((...args: any[]) => args),
  ilike: jest.fn((col: any, val: any) => ({ col, val, op: 'ilike' })),
  eq: jest.fn((col: any, val: any) => ({ col, val, op: 'eq' })),
  and: jest.fn((...args: any[]) => args),
}));

jest.mock('drizzle-orm/column', () => ({}));
jest.mock('drizzle-orm/pg-core', () => ({}));

import { PipelineService } from '../src/services/pipeline-service';

// Retrieve mock functions from the hoisted mock
const { __mockFind: mockFind, __mockSetDefault: mockSetDefault } =
  jest.requireMock('@mwashburn160/pipeline-core');

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PipelineService', () => {
  let service: PipelineService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new PipelineService();
  });

  describe('findByProject', () => {
    it('should call find with project and isActive filter', async () => {
      const expected = [{ id: '1', project: 'my-project' }];
      mockFind.mockResolvedValueOnce(expected);

      const result = await service.findByProject('my-project', 'org-1');

      expect(mockFind).toHaveBeenCalledWith(
        { project: 'my-project', isActive: true },
        'org-1',
      );
      expect(result).toEqual(expected);
    });

    it('should return empty array when no pipelines found', async () => {
      mockFind.mockResolvedValueOnce([]);

      const result = await service.findByProject('nonexistent', 'org-1');
      expect(result).toEqual([]);
    });
  });

  describe('getDefaultForProject', () => {
    it('should return default active pipeline for project', async () => {
      const pipeline = { id: '1', project: 'proj', organization: 'org', isDefault: true };
      mockFind.mockResolvedValueOnce([pipeline]);

      const result = await service.getDefaultForProject('proj', 'org', 'org-1');

      expect(mockFind).toHaveBeenCalledWith(
        { project: 'proj', organization: 'org', isDefault: true, isActive: true },
        'org-1',
      );
      expect(result).toEqual(pipeline);
    });

    it('should return null when no default pipeline exists', async () => {
      mockFind.mockResolvedValueOnce([]);

      const result = await service.getDefaultForProject('proj', 'org', 'org-1');
      expect(result).toBeNull();
    });
  });

  describe('setDefaultForProject', () => {
    it('should call setDefault with project and organization fields', async () => {
      const updated = { id: 'pipeline-1', isDefault: true };
      mockSetDefault.mockResolvedValueOnce(updated);

      const result = await service.setDefaultForProject('proj', 'org', 'pipeline-1', 'user-1');

      expect(mockSetDefault).toHaveBeenCalledWith(
        'project', 'organization', 'proj', 'org', 'pipeline-1', 'user-1',
      );
      expect(result).toEqual(updated);
    });
  });

  describe('createAsDefault', () => {
    it('should clear existing defaults and create new pipeline in a transaction', async () => {
      const data = { orgId: 'org-1', project: 'proj', organization: 'org' } as any;

      const result = await service.createAsDefault(data, 'user-1', 'proj', 'org');

      // Verify transaction was used
      const { db } = jest.requireMock('@mwashburn160/pipeline-core');
      expect(db.transaction).toHaveBeenCalled();

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

  describe('buildSearchConditions', () => {
    it('should return search and access control conditions', () => {
      const conditions = (service as any).buildSearchConditions('test', 'org-1');
      expect(conditions).toHaveLength(2);
    });
  });
});
