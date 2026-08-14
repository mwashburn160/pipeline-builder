// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for CrudService base class.
 *
 * Since CrudService depends on Drizzle ORM, we mock the db module and test
 * the service contract, access control, and error handling.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { SQL } from 'drizzle-orm';
import type { AnyColumn } from 'drizzle-orm/column';
import type { PgTable } from 'drizzle-orm/pg-core';
import { apiCoreMock } from './helpers/mock-api-core.js';

// Must declare mocks before unstable_mockModule registration
const mockSelect = jest.fn();
const mockInsert = jest.fn();
const mockUpdate = jest.fn();
const mockTransaction = jest.fn();

jest.unstable_mockModule('../src/database/postgres-connection.js', () => ({
  db: {
    select: mockSelect,
    insert: mockInsert,
    update: mockUpdate,
    transaction: mockTransaction,
  },
}));

// withTenantTx wraps every CrudService query in a tx that SET LOCALs the
// RLS GUCs (see src/database/tenancy.ts). For unit tests we mock it to a
// pass-through that invokes the callback with the same fake `db` so existing
// `mockSelect` / `mockInsert` / `mockUpdate` assertions still match. The
// real tx-wrapping is exercised by the tenancy module's own tests.
// Stubbed `tx.execute` for setDefault's FOR UPDATE row lock; tests don't
// inspect the lock query so a no-op resolve is enough.
const mockExecute = jest.fn().mockResolvedValue(undefined);
const mockDelete = jest.fn();

// Tenant context is mockable per-test: enforceOrgId / setDefault read it to pin
// writes to the caller's org. Default is `undefined` (out-of-context / worker
// path — enforceOrgId is a no-op) as before; individual tests set a real
// non-sysadmin (or sysadmin) context to exercise the tenant-stamp behavior.
interface FakeTenantContext { orgId?: string; isSuperAdmin: boolean }
let currentTenantContext: FakeTenantContext | undefined;
const mockGetTenantContext = jest.fn<() => FakeTenantContext | undefined>(() => currentTenantContext);

jest.unstable_mockModule('../src/database/tenancy.js', () => ({
  withTenantTx: (fn: (tx: unknown) => unknown) => fn({
    select: mockSelect,
    insert: mockInsert,
    update: mockUpdate,
    delete: mockDelete,
    execute: mockExecute,
  }),
  runWithTenantContext: <T>(_ctx: unknown, fn: () => T) => fn(),
  getTenantContext: () => mockGetTenantContext(),
  tenantContext: { run: <T>(_ctx: unknown, fn: () => T) => fn(), getStore: () => undefined },
}));

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock());

// Import after mocks are set up
import type { CrudService as CrudServiceType, BaseEntity } from '../src/api/crud-service.js';
const { CrudService } = await import('../src/api/crud-service.js') as {
  CrudService: typeof CrudServiceType;
};

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

// `id` is a (fake) column so writeConditions/findById can build the exact-id
// equality that neutralizes prefix matching on the single-entity paths — same
// empty-object column stand-in used for mockOrgColumn.
const mockSchema = { id: {}, name: {}, isActive: {}, isDefault: {} } as unknown as PgTable;
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
    // Default: no tenant scope (out-of-context path) unless a test opts in.
    currentTenantContext = undefined;
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

      // setDefault now runs through withTenantTx (mocked above to invoke
      // its callback with `{ select, insert, update, delete, execute }`).
      // Stub mockUpdate's chain to yield the row; mockExecute is the
      // FOR UPDATE row lock.
      mockExecute.mockResolvedValueOnce([]);
      mockUpdate.mockReturnValue({
        set: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            returning: jest.fn().mockResolvedValue([updated]),
          }),
        }),
      });

      const result = await service.setDefault('my-project', 'org1', 'target-id', 'user1');
      expect(result).toEqual(updated);
      // Two UPDATEs run inside setDefault: clear existing defaults, then
      // set the target row.
      expect(mockUpdate).toHaveBeenCalledTimes(2);
    });

    it('should throw NotFoundError when entity not found', async () => {
      mockExecute.mockResolvedValueOnce([]);
      mockUpdate.mockReturnValue({
        set: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            returning: jest.fn().mockResolvedValue([]),
          }),
        }),
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

    it('pins the write to the caller org (adds the own-org guard via getOrgColumn)', async () => {
      // Regression: updateMany used only buildConditions, which also matches
      // system/other-org PUBLIC rows. It must add the same own-org write-pin
      // (eq(getOrgColumn(), orgId)) that update/delete/bulkDelete use so it
      // can't mutate another org's/system public rows.
      const whereSpy = jest.fn().mockReturnValue({
        returning: jest.fn().mockResolvedValue([]),
      });
      mockUpdate.mockReturnValue({ set: jest.fn().mockReturnValue({ where: whereSpy }) });

      const orgColumnSpy = jest.spyOn(service as any, 'getOrgColumn');
      await service.updateMany({ name: 'old' }, { name: 'X' }, 'org1', 'user1');
      // The write-pin invokes getOrgColumn() to build eq(col, orgId).
      expect(orgColumnSpy).toHaveBeenCalled();
      expect(whereSpy).toHaveBeenCalled();
    });

    it('omits the own-org pin for an orgId-less (sysadmin) context', async () => {
      const whereSpy = jest.fn().mockReturnValue({
        returning: jest.fn().mockResolvedValue([]),
      });
      mockUpdate.mockReturnValue({ set: jest.fn().mockReturnValue({ where: whereSpy }) });

      const orgColumnSpy = jest.spyOn(service as any, 'getOrgColumn');
      await service.updateMany({ name: 'old' }, { name: 'X' }, '', 'user1');
      // Empty orgId ⇒ no pin ⇒ getOrgColumn() is not consulted for the write.
      expect(orgColumnSpy).not.toHaveBeenCalled();
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

  // Lifecycle hooks — Phase 1 cleanup awaits onAfter* before returning.
  // Verifies post-hook state is observable on a subsequent read, and that
  // a throwing hook is caught + logged (not propagated to the caller).

  describe('lifecycle hooks', () => {
    /** Subclass that exposes hook state we can inspect from the test. */
    class HookedService extends TestService {
      public createHookCompleted = false;
      public updateHookCompleted = false;
      public deleteHookCompleted = false;
      public hookCallOrder: string[] = [];

      protected override async onAfterCreate(entity: TestEntity, _userId: string): Promise<void> {
        // Resolve after a microtask to prove the caller awaits us
        await Promise.resolve();
        await new Promise<void>(resolve => setTimeout(resolve, 0));
        this.createHookCompleted = true;
        this.hookCallOrder.push(`create:${entity.id}`);
      }

      protected override async onAfterUpdate(id: string, _entity: TestEntity, _userId: string): Promise<void> {
        await Promise.resolve();
        this.updateHookCompleted = true;
        this.hookCallOrder.push(`update:${id}`);
      }

      protected override async onAfterDelete(id: string, _entity: TestEntity, _userId: string): Promise<void> {
        await Promise.resolve();
        this.deleteHookCompleted = true;
        this.hookCallOrder.push(`delete:${id}`);
      }
    }

    /** Subclass whose hook throws — verifies error containment. */
    class FailingHookService extends TestService {
      public hookCalled = false;
      protected override async onAfterCreate(_entity: TestEntity, _userId: string): Promise<void> {
        this.hookCalled = true;
        throw new Error('hook explosion');
      }
    }

    const created: TestEntity = {
      id: 'hook-test',
      orgId: 'org1',
      name: 'Hooked',
      isDefault: false,
      createdAt: new Date(),
      updatedAt: new Date(),
      createdBy: 'user1',
      updatedBy: 'user1',
    };

    it('should await onAfterCreate before resolving create()', async () => {
      const svc = new HookedService();

      mockInsert.mockReturnValue({
        values: jest.fn().mockReturnValue({
          onConflictDoUpdate: jest.fn().mockReturnValue({
            returning: jest.fn().mockResolvedValue([created]),
          }),
        }),
      });

      expect(svc.createHookCompleted).toBe(false);
      const result = await svc.create({ name: 'Hooked', orgId: 'org1' }, 'user1');
      // Post-hook state must be observable on a subsequent read
      expect(svc.createHookCompleted).toBe(true);
      expect(svc.hookCallOrder).toEqual(['create:hook-test']);
      expect(result).toEqual(created);
    });

    it('should await onAfterUpdate before resolving update()', async () => {
      const svc = new HookedService();

      mockUpdate.mockReturnValue({
        set: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            returning: jest.fn().mockResolvedValue([created]),
          }),
        }),
      });

      const result = await svc.update('hook-test', { name: 'X' }, 'org1', 'user1');
      expect(svc.updateHookCompleted).toBe(true);
      expect(svc.hookCallOrder).toEqual(['update:hook-test']);
      expect(result).toEqual(created);
    });

    it('should await onAfterDelete before resolving delete()', async () => {
      const svc = new HookedService();

      mockUpdate.mockReturnValue({
        set: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            returning: jest.fn().mockResolvedValue([created]),
          }),
        }),
      });

      const result = await svc.delete('hook-test', 'org1', 'user1');
      expect(svc.deleteHookCompleted).toBe(true);
      expect(svc.hookCallOrder).toEqual(['delete:hook-test']);
      expect(result).toEqual(created);
    });

    it('should catch and not propagate hook errors from create()', async () => {
      const svc = new FailingHookService();

      mockInsert.mockReturnValue({
        values: jest.fn().mockReturnValue({
          onConflictDoUpdate: jest.fn().mockReturnValue({
            returning: jest.fn().mockResolvedValue([created]),
          }),
        }),
      });

      // Should NOT throw despite the hook throwing
      const result = await svc.create({ name: 'X', orgId: 'org1' }, 'user1');
      expect(svc.hookCalled).toBe(true);
      expect(result).toEqual(created);
    });

    it('should not invoke onAfterUpdate when no row is updated', async () => {
      const svc = new HookedService();

      mockUpdate.mockReturnValue({
        set: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            returning: jest.fn().mockResolvedValue([]),
          }),
        }),
      });

      const result = await svc.update('missing', { name: 'X' }, 'org1', 'user1');
      expect(result).toBeNull();
      expect(svc.updateHookCompleted).toBe(false);
    });

    it('should not invoke onAfterDelete when no row is deleted', async () => {
      const svc = new HookedService();

      mockUpdate.mockReturnValue({
        set: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            returning: jest.fn().mockResolvedValue([]),
          }),
        }),
      });

      const result = await svc.delete('missing', 'org1', 'user1');
      expect(result).toBeNull();
      expect(svc.deleteHookCompleted).toBe(false);
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

  // count / find parity for parentOrgId widening (org → team hierarchy).
  // Regression guard: count() used to omit parentOrgId, so a paged list's
  // `total` was computed from a NARROWER WHERE than the widened find() rows.
  // count() must now pass parentOrgId into buildConditions exactly like find().

  describe('count/find parentOrgId parity', () => {
    /** Records every (orgId, parentOrgId) buildConditions is invoked with. */
    class CapturingService extends TestService {
      public calls: Array<{ orgId?: string; parentOrgId?: string }> = [];
      protected override buildConditions(
        _filter: Partial<TestFilter>,
        orgId?: string,
        parentOrgId?: string,
      ): SQL[] {
        this.calls.push({ orgId, parentOrgId });
        return [{ orgId, parentOrgId } as unknown as SQL];
      }
    }

    it('count() widens to parentOrgId with the same buildConditions args as find()', async () => {
      const svc = new CapturingService();

      // Widened find()
      mockSelect.mockReturnValueOnce({
        from: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([]) }),
      });
      await svc.find({}, 'org1', 'parent1');

      // Widened count()
      mockSelect.mockReturnValueOnce({
        from: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([{ count: 7 }]) }),
      });
      const total = await svc.count({}, 'org1', 'parent1');

      expect(total).toBe(7);
      // Both reads must build their WHERE with the identical widening args,
      // so the total counts the same row set the widened find() would return.
      expect(svc.calls).toEqual([
        { orgId: 'org1', parentOrgId: 'parent1' },
        { orgId: 'org1', parentOrgId: 'parent1' },
      ]);
    });

    it('count() stays own-org scoped (no parentOrgId) when not widened', async () => {
      const svc = new CapturingService();

      mockSelect.mockReturnValueOnce({
        from: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([{ count: 2 }]) }),
      });
      const total = await svc.count({}, 'org1');

      expect(total).toBe(2);
      expect(svc.calls).toEqual([{ orgId: 'org1', parentOrgId: undefined }]);
    });
  });

  // enforceOrgId — tenant-write stamp (the fail-open fix).
  //
  // These run with a REAL non-sysadmin tenant context (the default mock returns
  // undefined, which makes enforceOrgId a no-op). A non-sysadmin write MUST land
  // in the caller's own org: the org_id column DEFAULTs to SYSTEM_ORG_ID, so an
  // insert that omits orgId would otherwise drop the tenant's row into the public
  // system catalog — a cross-tenant fail-open. enforceOrgId always stamps
  // ctx.orgId (absent → inject, mismatch → override); sysadmin/out-of-context
  // callers pass through untouched.

  describe('enforceOrgId tenant stamp', () => {
    const created: TestEntity = {
      id: 'created-id',
      orgId: 'org1',
      name: 'X',
      isDefault: false,
      createdAt: new Date(),
      updatedAt: new Date(),
      createdBy: 'user1',
      updatedBy: 'user1',
    };

    /** Wire create()'s insert chain and return the spy on `.values()`. */
    function captureCreateValues() {
      const valuesSpy = jest.fn().mockReturnValue({
        onConflictDoUpdate: jest.fn().mockReturnValue({
          returning: jest.fn().mockResolvedValue([created]),
        }),
      });
      mockInsert.mockReturnValue({ values: valuesSpy });
      return valuesSpy;
    }

    it('injects ctx.orgId when the insert OMITS orgId (fail-open fix)', async () => {
      currentTenantContext = { orgId: 'org1', isSuperAdmin: false };
      const valuesSpy = captureCreateValues();

      await service.create({ name: 'no-org' } as unknown as TestInsert, 'user1');

      // Without the stamp this row would default to SYSTEM_ORG_ID.
      expect(valuesSpy.mock.calls[0][0].orgId).toBe('org1');
    });

    it('overrides a mismatched caller-supplied orgId', async () => {
      currentTenantContext = { orgId: 'org1', isSuperAdmin: false };
      const valuesSpy = captureCreateValues();

      await service.create({ name: 'x', orgId: 'attacker-org' }, 'user1');

      expect(valuesSpy.mock.calls[0][0].orgId).toBe('org1');
    });

    it('leaves a matching orgId unchanged', async () => {
      currentTenantContext = { orgId: 'org1', isSuperAdmin: false };
      const valuesSpy = captureCreateValues();

      await service.create({ name: 'x', orgId: 'org1' }, 'user1');

      expect(valuesSpy.mock.calls[0][0].orgId).toBe('org1');
    });

    it('passes a sysadmin context through untouched', async () => {
      currentTenantContext = { orgId: 'system', isSuperAdmin: true };
      const valuesSpy = captureCreateValues();

      await service.create({ name: 'x', orgId: 'some-other-org' }, 'user1');

      // Sysadmin may write into any org — the supplied org survives.
      expect(valuesSpy.mock.calls[0][0].orgId).toBe('some-other-org');
    });

    it('passes through when there is no tenant scope (worker/system path)', async () => {
      currentTenantContext = undefined;
      const valuesSpy = captureCreateValues();

      await service.create({ name: 'x', orgId: 'explicit-org' }, 'user1');

      expect(valuesSpy.mock.calls[0][0].orgId).toBe('explicit-org');
    });

    it('also stamps the tenant org on update payloads (re-home prevention)', async () => {
      currentTenantContext = { orgId: 'org1', isSuperAdmin: false };
      const setSpy = jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          returning: jest.fn().mockResolvedValue([created]),
        }),
      });
      mockUpdate.mockReturnValue({ set: setSpy });

      await service.update('id1', { orgId: 'attacker-org', name: 'x' } as any, 'org1', 'user1');

      expect(setSpy.mock.calls[0][0].orgId).toBe('org1');
    });

    // Log-level policy: the ABSENT-orgId stamp is the common normal-write path,
    // so it must log at debug (not warn) to avoid flooding; a PRESENT-but-
    // mismatched orgId is an override attempt and stays at warn.
    it('logs the absent-orgId stamp at DEBUG, not warn (no log flood on normal writes)', async () => {
      currentTenantContext = { orgId: 'org1', isSuperAdmin: false };
      captureCreateValues();
      const logger = (service as unknown as { _logger: { warn: jest.Mock; debug: jest.Mock } })._logger;
      const warnSpy = jest.spyOn(logger, 'warn');
      const debugSpy = jest.spyOn(logger, 'debug');

      await service.create({ name: 'no-org' } as unknown as TestInsert, 'user1');

      expect(debugSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy).not.toHaveBeenCalled();
      warnSpy.mockRestore();
      debugSpy.mockRestore();
    });

    it('logs a mismatched-orgId override at WARN (real override attempt)', async () => {
      currentTenantContext = { orgId: 'org1', isSuperAdmin: false };
      captureCreateValues();
      const logger = (service as unknown as { _logger: { warn: jest.Mock; debug: jest.Mock } })._logger;
      const warnSpy = jest.spyOn(logger, 'warn');
      const debugSpy = jest.spyOn(logger, 'debug');

      await service.create({ name: 'x', orgId: 'attacker-org' }, 'user1');

      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(debugSpy).not.toHaveBeenCalled();
      warnSpy.mockRestore();
      debugSpy.mockRestore();
    });
  });

  // Cursor pagination — the sort column must survive a sparse fieldset so the
  // next cursor (lastItem[sortBy]) resolves; otherwise the client stalls on
  // page 1. Regression guard for buildFieldSelect(fields, sortBy).

  describe('cursor pagination sortBy inclusion', () => {
    const row: TestEntity = {
      id: 'last-id',
      orgId: 'org1',
      name: 'Z',
      isDefault: false,
      createdAt: new Date(),
      updatedAt: new Date(),
      createdBy: 'u',
      updatedBy: 'u',
    };

    it('adds the sortBy column to the projection even when fields omit it', async () => {
      const offset = jest.fn().mockResolvedValue([row]);
      const limit = jest.fn().mockReturnValue({ offset });
      const orderBy = jest.fn().mockReturnValue({ limit });
      const where = jest.fn().mockReturnValue({ orderBy, limit });
      const from = jest.fn().mockReturnValue({ where });
      mockSelect.mockReturnValueOnce({ from } as unknown as ReturnType<typeof mockSelect>);

      const result = await service.findPaginated({}, 'org1', {
        fields: ['id'], // caller omits the sort column
        sortBy: 'name',
        cursor: 'prev-cursor', // activates cursor pagination
      });

      // The projection passed to tx.select(...) must include the sort column.
      const spec = mockSelect.mock.calls[0][0] as Record<string, unknown>;
      expect(spec).toHaveProperty('name');
      expect(spec).toHaveProperty('id');
      // And the next cursor is produced from that column's value.
      expect(result.nextCursor).toBe('Z');
    });
  });

  // setDefault cleanup — must not promote a soft-deleted row, and must pin the
  // target with the lowercased exact-id predicate the mutation paths use.

  describe('setDefault cleanup (isActive guard + exact id)', () => {
    /** Recursively scan a drizzle SQL node for a specific column reference. */
    function sqlContains(node: unknown, target: unknown): boolean {
      if (node === target) return true;
      if (node && typeof node === 'object') {
        const chunks = (node as { queryChunks?: unknown[] }).queryChunks;
        if (Array.isArray(chunks)) return chunks.some((c) => sqlContains(c, target));
        return Object.values(node as Record<string, unknown>).some((v) => sqlContains(v, target));
      }
      return false;
    }

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

    it('promotes only an active row via the lowercased exactIdCondition', async () => {
      mockExecute.mockResolvedValueOnce([]);
      const exactSpy = jest.spyOn(service as unknown as { exactIdCondition: (id: string) => SQL }, 'exactIdCondition');

      const clearWhere = jest.fn().mockReturnValue(undefined);
      const targetWhere = jest.fn().mockReturnValue({
        returning: jest.fn().mockResolvedValue([updated]),
      });
      mockUpdate
        .mockReturnValueOnce({ set: jest.fn().mockReturnValue({ where: clearWhere }) })
        .mockReturnValueOnce({ set: jest.fn().mockReturnValue({ where: targetWhere }) });

      const result = await service.setDefault('proj', 'org1', 'TARGET-ID', 'user1');
      expect(result).toEqual(updated);

      // exactId cleanup: the target row is pinned with the lowercased exact-id
      // predicate (was a raw eq(cols.id, id) that skipped the lower-casing).
      expect(exactSpy).toHaveBeenCalledWith('TARGET-ID');

      // isActive guard: the target UPDATE's WHERE must reference the isActive
      // column so a soft-deleted row can never be promoted to default.
      const targetWhereArg = targetWhere.mock.calls[0][0];
      expect(sqlContains(targetWhereArg, (mockSchema as unknown as { isActive: unknown }).isActive)).toBe(true);
    });
  });
});
