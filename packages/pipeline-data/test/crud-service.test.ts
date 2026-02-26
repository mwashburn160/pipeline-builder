/**
 * Tests for CrudService base class.
 *
 * Since CrudService depends on Drizzle ORM, we mock the db module and test
 * the service contract, access control, and error handling.
 */

import { SQL } from 'drizzle-orm';
import type { AnyColumn } from 'drizzle-orm/column';
import type { PgTable } from 'drizzle-orm/pg-core';

// Must declare mocks before jest.mock() hoisting
const mockSelect = jest.fn();
const mockInsert = jest.fn();
const mockUpdate = jest.fn();
const mockTransaction = jest.fn();

jest.mock('../src/database/postgres-connection', () => ({
  db: {
    select: mockSelect,
    insert: mockInsert,
    update: mockUpdate,
    transaction: mockTransaction,
  },
}));

jest.mock('@mwashburn160/api-core', () => ({
  createLogger: () => ({
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  }),
}));

// Import after mocks are set up
import { CrudService, BaseEntity } from '../src/api/crud-service';

// ============================================================================
// Concrete test implementation
// ============================================================================

interface TestEntity extends BaseEntity {
  name: string;
}

interface TestFilter {
  id?: string;
  name?: string;
}

interface TestInsert {
  name: string;
  orgId: string;
}

interface TestUpdate {
  name?: string;
}

const mockSchema = {} as PgTable;
const mockProjectColumn = {} as AnyColumn;
const mockOrgColumn = {} as AnyColumn;

class TestService extends CrudService<TestEntity, TestFilter, TestInsert, TestUpdate> {
  protected get schema(): PgTable {
    return mockSchema;
  }

  protected buildConditions(_filter: Partial<TestFilter>, orgId: string): SQL[] {
    return [{ orgId } as unknown as SQL];
  }

  protected getSortColumn(sortBy: string): AnyColumn | null {
    if (sortBy === 'name') return {} as AnyColumn;
    return null;
  }

  protected getProjectColumn(): AnyColumn | null {
    return mockProjectColumn;
  }

  protected getOrgColumn(): AnyColumn {
    return mockOrgColumn;
  }
}

// ============================================================================
// Tests
// ============================================================================

describe('CrudService', () => {
  let service: TestService;

  beforeEach(() => {
    service = new TestService();
    jest.clearAllMocks();
  });

  // --------------------------------------------------------------------------
  // findById
  // --------------------------------------------------------------------------

  describe('findById', () => {
    it('should return entity when found', async () => {
      const entity: TestEntity = {
        id: 'test-id',
        orgId: 'org1',
        name: 'Test',
        isDefault: false,
        createdAt: new Date(),
        updatedAt: new Date(),
        createdBy: 'user1',
        updatedBy: 'user1',
      };

      mockSelect.mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            limit: jest.fn().mockResolvedValue([entity]),
          }),
        }),
      });

      const result = await service.findById('test-id', 'org1');
      expect(result).toEqual(entity);
      expect(mockSelect).toHaveBeenCalled();
    });

    it('should return null when not found', async () => {
      mockSelect.mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            limit: jest.fn().mockResolvedValue([]),
          }),
        }),
      });

      const result = await service.findById('missing-id', 'org1');
      expect(result).toBeNull();
    });

    it('should propagate database errors', async () => {
      mockSelect.mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            limit: jest.fn().mockRejectedValue(new Error('DB connection lost')),
          }),
        }),
      });

      await expect(service.findById('test-id', 'org1')).rejects.toThrow('DB connection lost');
    });
  });

  // --------------------------------------------------------------------------
  // find
  // --------------------------------------------------------------------------

  describe('find', () => {
    it('should return matching entities', async () => {
      const entities: TestEntity[] = [
        {
          id: '1',
          orgId: 'org1',
          name: 'A',
          isDefault: false,
          createdAt: new Date(),
          updatedAt: new Date(),
          createdBy: 'u',
          updatedBy: 'u',
        },
        {
          id: '2',
          orgId: 'org1',
          name: 'B',
          isDefault: false,
          createdAt: new Date(),
          updatedAt: new Date(),
          createdBy: 'u',
          updatedBy: 'u',
        },
      ];

      mockSelect.mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockResolvedValue(entities),
        }),
      });

      const result = await service.find({}, 'org1');
      expect(result).toHaveLength(2);
      expect(result[0].name).toBe('A');
    });

    it('should return empty array when no matches', async () => {
      mockSelect.mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockResolvedValue([]),
        }),
      });

      const result = await service.find({ name: 'nonexistent' }, 'org1');
      expect(result).toEqual([]);
    });
  });

  // --------------------------------------------------------------------------
  // create
  // --------------------------------------------------------------------------

  describe('create', () => {
    it('should create and return entity', async () => {
      const created: TestEntity = {
        id: 'new-id',
        orgId: 'org1',
        name: 'New',
        isDefault: false,
        createdAt: new Date(),
        updatedAt: new Date(),
        createdBy: 'user1',
        updatedBy: 'user1',
      };

      const valuesChain = {
        returning: jest.fn().mockResolvedValue([created]),
      };
      mockInsert.mockReturnValue({
        values: jest.fn().mockReturnValue(valuesChain),
      });

      const result = await service.create({ name: 'New', orgId: 'org1' }, 'user1');
      expect(result).toEqual(created);
    });

    it('should propagate insert errors', async () => {
      mockInsert.mockReturnValue({
        values: jest.fn().mockReturnValue({
          returning: jest.fn().mockRejectedValue(new Error('Unique constraint violation')),
        }),
      });

      await expect(
        service.create({ name: 'Duplicate', orgId: 'org1' }, 'user1'),
      ).rejects.toThrow('Unique constraint violation');
    });
  });

  // --------------------------------------------------------------------------
  // update
  // --------------------------------------------------------------------------

  describe('update', () => {
    it('should update and return entity', async () => {
      const updated: TestEntity = {
        id: 'test-id',
        orgId: 'org1',
        name: 'Updated',
        isDefault: false,
        createdAt: new Date(),
        updatedAt: new Date(),
        createdBy: 'user1',
        updatedBy: 'user1',
      };

      mockUpdate.mockReturnValue({
        set: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            returning: jest.fn().mockResolvedValue([updated]),
          }),
        }),
      });

      const result = await service.update('test-id', { name: 'Updated' }, 'org1', 'user1');
      expect(result).toEqual(updated);
      expect(result!.name).toBe('Updated');
    });

    it('should return null when entity not found', async () => {
      mockUpdate.mockReturnValue({
        set: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            returning: jest.fn().mockResolvedValue([]),
          }),
        }),
      });

      const result = await service.update('missing-id', { name: 'X' }, 'org1', 'user1');
      expect(result).toBeNull();
    });
  });

  // --------------------------------------------------------------------------
  // delete (soft delete)
  // --------------------------------------------------------------------------

  describe('delete', () => {
    it('should soft-delete and return entity', async () => {
      const deleted: TestEntity = {
        id: 'test-id',
        orgId: 'org1',
        name: 'Deleted',
        isDefault: false,
        createdAt: new Date(),
        updatedAt: new Date(),
        createdBy: 'user1',
        updatedBy: 'user1',
      };

      const setMock = jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          returning: jest.fn().mockResolvedValue([deleted]),
        }),
      });
      mockUpdate.mockReturnValue({ set: setMock });

      const result = await service.delete('test-id', 'org1', 'user1');
      expect(result).toEqual(deleted);

      // Verify soft-delete sets isActive: false
      const setCall = setMock.mock.calls[0][0];
      expect(setCall.isActive).toBe(false);
    });

    it('should return null when entity not found', async () => {
      mockUpdate.mockReturnValue({
        set: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            returning: jest.fn().mockResolvedValue([]),
          }),
        }),
      });

      const result = await service.delete('missing-id', 'org1', 'user1');
      expect(result).toBeNull();
    });
  });

  // --------------------------------------------------------------------------
  // setDefault
  // --------------------------------------------------------------------------

  describe('setDefault', () => {
    it('should set default within a transaction', async () => {
      const updated: TestEntity = {
        id: 'target-id',
        orgId: 'org1',
        name: 'Default',
        isDefault: true,
        createdAt: new Date(),
        updatedAt: new Date(),
        createdBy: 'user1',
        updatedBy: 'user1',
      };

      // Mock transaction to execute the callback with a mock tx
      mockTransaction.mockImplementation(async (cb: Function) => {
        const tx = {
          update: jest.fn().mockReturnValue({
            set: jest.fn().mockReturnValue({
              where: jest.fn().mockReturnValue({
                returning: jest.fn().mockResolvedValue([updated]),
              }),
            }),
          }),
        };
        return cb(tx);
      });

      const result = await service.setDefault('my-project', 'org1', 'target-id', 'user1');
      expect(result).toEqual(updated);
      expect(mockTransaction).toHaveBeenCalledTimes(1);
    });

    it('should throw when entity not found', async () => {
      mockTransaction.mockImplementation(async (cb: Function) => {
        const tx = {
          update: jest.fn().mockReturnValue({
            set: jest.fn().mockReturnValue({
              where: jest.fn().mockReturnValue({
                returning: jest.fn().mockResolvedValue([]),
              }),
            }),
          }),
        };
        return cb(tx);
      });

      await expect(
        service.setDefault('my-project', 'org1', 'missing-id', 'user1'),
      ).rejects.toThrow('Entity with id missing-id not found');
    });
  });

  // --------------------------------------------------------------------------
  // updateMany
  // --------------------------------------------------------------------------

  describe('updateMany', () => {
    it('should update multiple entities', async () => {
      const updated: TestEntity[] = [
        {
          id: '1',
          orgId: 'org1',
          name: 'Updated',
          isDefault: false,
          createdAt: new Date(),
          updatedAt: new Date(),
          createdBy: 'u',
          updatedBy: 'u',
        },
        {
          id: '2',
          orgId: 'org1',
          name: 'Updated',
          isDefault: false,
          createdAt: new Date(),
          updatedAt: new Date(),
          createdBy: 'u',
          updatedBy: 'u',
        },
      ];

      mockUpdate.mockReturnValue({
        set: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            returning: jest.fn().mockResolvedValue(updated),
          }),
        }),
      });

      const result = await service.updateMany({ name: 'old' }, { name: 'Updated' }, 'org1', 'user1');
      expect(result).toHaveLength(2);
    });
  });
});
