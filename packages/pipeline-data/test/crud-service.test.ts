// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

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

jest.mock('@pipeline-builder/api-core', () => {
  class NotFoundError extends Error {
    statusCode = 404;
    code = 'NOT_FOUND';
    constructor(message: string) { super(message); this.name = 'NotFoundError'; }
  }
  return {
    NotFoundError,
    createLogger: () => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
  };
});

// Import after mocks are set up
import { CrudService, BaseEntity } from '../src/api/crud-service';

// Concrete test implementation

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
const mockConflictTarget = [{} as AnyColumn, {} as AnyColumn];

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

  protected get conflictTarget(): AnyColumn[] {
    return mockConflictTarget;
  }
}

// Tests

describe('CrudService', () => {
  let service: TestService;

  beforeEach(() => {
    service = new TestService();
    jest.clearAllMocks();
  });

  // findById

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

  // find

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

  // create

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

      mockInsert.mockReturnValue({
        values: jest.fn().mockReturnValue({
          onConflictDoUpdate: jest.fn().mockReturnValue({
            returning: jest.fn().mockResolvedValue([created]),
          }),
        }),
      });

      const result = await service.create({ name: 'New', orgId: 'org1' }, 'user1');
      expect(result).toEqual(created);
    });

    it('should upsert on conflict', async () => {
      const upserted: TestEntity = {
        id: 'existing-id',
        orgId: 'org1',
        name: 'Updated',
        isDefault: false,
        createdAt: new Date(),
        updatedAt: new Date(),
        createdBy: 'original-user',
        updatedBy: 'user1',
      };

      const onConflictMock = jest.fn().mockReturnValue({
        returning: jest.fn().mockResolvedValue([upserted]),
      });
      mockInsert.mockReturnValue({
        values: jest.fn().mockReturnValue({
          onConflictDoUpdate: onConflictMock,
        }),
      });

      const result = await service.create({ name: 'Updated', orgId: 'org1' }, 'user1');
      expect(result).toEqual(upserted);

      // Verify onConflictDoUpdate was called with correct structure
      const conflictArg = onConflictMock.mock.calls[0][0];
      expect(conflictArg.target).toBe(mockConflictTarget);
      expect(conflictArg.set).toMatchObject({
        name: 'Updated',
        orgId: 'org1',
        updatedBy: 'user1',
      });
      expect(conflictArg.set.updatedAt).toBeInstanceOf(Date);
    });

    it('should propagate insert errors', async () => {
      mockInsert.mockReturnValue({
        values: jest.fn().mockReturnValue({
          onConflictDoUpdate: jest.fn().mockReturnValue({
            returning: jest.fn().mockRejectedValue(new Error('DB error')),
          }),
        }),
      });

      await expect(
        service.create({ name: 'Duplicate', orgId: 'org1' }, 'user1'),
      ).rejects.toThrow('DB error');
    });
  });

  // update

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

  // delete (soft delete)

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

      // Verify soft-delete sets all expected fields
      const setCall = setMock.mock.calls[0][0];
      expect(setCall.isActive).toBe(false);
      expect(setCall.deletedAt).toBeInstanceOf(Date);
      expect(setCall.deletedBy).toBe('user1');
      expect(setCall.updatedAt).toBeInstanceOf(Date);
      expect(setCall.updatedBy).toBe('user1');
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

  // setDefault

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
          execute: jest.fn().mockResolvedValue([]),
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

    it('should throw NotFoundError when entity not found', async () => {
      mockTransaction.mockImplementation(async (cb: Function) => {
        const tx = {
          execute: jest.fn().mockResolvedValue([]),
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

      try {
        await service.setDefault('my-project', 'org1', 'missing-id', 'user1');
      } catch (error) {
        expect((error as any).name).toBe('NotFoundError');
        expect((error as any).statusCode).toBe(404);
      }
    });
  });

  // updateMany

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

  // findPaginated

  describe('findPaginated', () => {
    const entity: TestEntity = {
      id: '1',
      orgId: 'org1',
      name: 'A',
      isDefault: false,
      createdAt: new Date(),
      updatedAt: new Date(),
      createdBy: 'u',
      updatedBy: 'u',
    };

    /** Mock for data-only query (LIMIT+1 trick — no separate COUNT). */
    function mockDataQuery(dataResult: TestEntity[]) {
      const dataQuery = {
        limit: jest.fn().mockReturnValue({
          offset: jest.fn().mockResolvedValue(dataResult),
        }),
        orderBy: jest.fn().mockReturnValue({
          limit: jest.fn().mockReturnValue({
            offset: jest.fn().mockResolvedValue(dataResult),
          }),
        }),
      };
      mockSelect.mockReturnValueOnce({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue(dataQuery),
        }),
      });
    }

    /** Mock for data query + COUNT query (when includeTotal=true). */
    function mockDataAndCountQuery(dataResult: TestEntity[], countResult: number) {
      mockDataQuery(dataResult);
      // Second call is for COUNT
      mockSelect.mockReturnValueOnce({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockResolvedValue([{ count: countResult }]),
        }),
      });
    }

    it('should return paginated results with defaults', async () => {
      mockDataQuery([entity, { ...entity, id: '2', name: 'B' }]);

      const result = await service.findPaginated({}, 'org1');
      expect(result.data).toHaveLength(2);
      expect(result.total).toBeUndefined(); // total omitted by default
      expect(result.limit).toBe(100); // DEFAULT_PAGE_LIMIT
      expect(result.offset).toBe(0);
      expect(result.hasMore).toBe(false);
    });

    it('should include total when includeTotal is true', async () => {
      mockDataAndCountQuery([entity, { ...entity, id: '2', name: 'B' }], 2);

      const result = await service.findPaginated({}, 'org1', { includeTotal: true });
      expect(result.data).toHaveLength(2);
      expect(result.total).toBe(2);
    });

    it('should return empty results', async () => {
      mockDataQuery([]);

      const result = await service.findPaginated({}, 'org1');
      expect(result.data).toEqual([]);
      expect(result.hasMore).toBe(false);
    });

    it('should clamp limit to minimum of 1', async () => {
      mockDataQuery([entity]);

      const result = await service.findPaginated({}, 'org1', { limit: 0 });
      expect(result.limit).toBe(1);
    });

    it('should clamp limit to maximum of 1000', async () => {
      mockDataQuery([entity]);

      const result = await service.findPaginated({}, 'org1', { limit: 5000 });
      expect(result.limit).toBe(1000);
    });

    it('should detect hasMore via LIMIT+1 trick', async () => {
      // Request limit=1, but return 2 rows (limit+1) to signal hasMore
      mockDataQuery([entity, { ...entity, id: '2', name: 'B' }]);

      const result = await service.findPaginated({}, 'org1', { limit: 1, offset: 0 });
      expect(result.data).toHaveLength(1); // Extra row trimmed
      expect(result.hasMore).toBe(true);
    });

    it('should propagate database errors', async () => {
      mockSelect.mockReturnValueOnce({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            limit: jest.fn().mockReturnValue({
              offset: jest.fn().mockRejectedValue(new Error('DB error')),
            }),
          }),
        }),
      });

      await expect(service.findPaginated({}, 'org1')).rejects.toThrow('DB error');
    });
  });

  // count

  describe('count', () => {
    it('should return count of matching entities', async () => {
      mockSelect.mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockResolvedValue([{ count: 5 }]),
        }),
      });

      const result = await service.count({}, 'org1');
      expect(result).toBe(5);
    });

    it('should return 0 when no entities match', async () => {
      mockSelect.mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockResolvedValue([{ count: 0 }]),
        }),
      });

      const result = await service.count({ name: 'nonexistent' }, 'org1');
      expect(result).toBe(0);
    });

    it('should propagate database errors', async () => {
      mockSelect.mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockRejectedValue(new Error('DB error')),
        }),
      });

      await expect(service.count({}, 'org1')).rejects.toThrow('DB error');
    });
  });
});
