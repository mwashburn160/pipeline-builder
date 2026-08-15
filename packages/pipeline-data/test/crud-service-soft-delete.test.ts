// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the soft-delete lifecycle methods on CrudService:
 * `restore`, `findDeletedById`, `findDeleted`, and `purgeExpired`.
 *
 * Mocks the db + tenancy modules the same way crud-service.test.ts does (a
 * pass-through `withTenantTx`), and drives a concrete TestService whose schema
 * carries the soft-delete columns (`deletedAt` + `purgeAfter`). A second
 * service WITHOUT those columns exercises the no-op / no-lifecycle branches.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { SQL } from 'drizzle-orm';
import type { AnyColumn } from 'drizzle-orm/column';
import type { PgTable } from 'drizzle-orm/pg-core';
import { apiCoreMock } from './helpers/mock-api-core.js';

const mockSelect = jest.fn();
const mockUpdate = jest.fn();
const mockDelete = jest.fn();
const mockExecute = jest.fn<() => Promise<unknown>>().mockResolvedValue(undefined);

jest.unstable_mockModule('../src/database/postgres-connection.js', () => ({
  db: { select: mockSelect, update: mockUpdate, delete: mockDelete, execute: mockExecute, transaction: jest.fn() },
}));

// Pass-through tenancy: withTenantTx invokes its callback with the fake tx, and
// runWithTenantContext just runs its fn (the sysadmin-scope wrapping is verified
// by the tenancy module's own tests + the sweep test's spy).
const runWithTenantContextSpy = jest.fn(<T>(_ctx: unknown, fn: () => T): T => fn());
jest.unstable_mockModule('../src/database/tenancy.js', () => ({
  withTenantTx: (fn: (tx: unknown) => unknown) => fn({
    select: mockSelect, update: mockUpdate, delete: mockDelete, execute: mockExecute,
  }),
  runWithTenantContext: runWithTenantContextSpy,
  getTenantContext: () => undefined,
  tenantContext: { run: <T>(_c: unknown, fn: () => T) => fn(), getStore: () => undefined },
}));

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock());

import type { CrudService as CrudServiceType, BaseEntity } from '../src/api/crud-service.js';
const { CrudService } = await import('../src/api/crud-service.js') as { CrudService: typeof CrudServiceType };

interface TestEntity extends BaseEntity { name: string }

const mockOrgColumn = {} as AnyColumn;

// Schema WITH the soft-delete lifecycle columns.
const lifecycleSchema = { id: {}, name: {}, isActive: {}, isDefault: {}, deletedAt: {}, purgeAfter: {} } as unknown as PgTable;
// Schema WITHOUT deletedAt/purgeAfter — restore/findDeleted*/purgeExpired must no-op.
const bareSchema = { id: {}, name: {}, isActive: {}, isDefault: {} } as unknown as PgTable;

class BaseTestService extends CrudService<TestEntity, { id?: string }, { name: string; orgId: string }, { name?: string }> {
  constructor(private readonly _schema: PgTable) { super(); }
  protected get schema(): PgTable { return this._schema; }
  protected buildConditions(): SQL[] { return []; }
  protected getSortColumn(): AnyColumn | null { return null; }
  protected getProjectColumn(): AnyColumn | null { return null; }
  protected getOrgColumn(): AnyColumn { return mockOrgColumn; }
  protected get conflictTarget(): AnyColumn[] { return [{} as AnyColumn]; }
}

// Subclass exposing the lifecycle hooks as spies.
const onAfterRestore = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
const onBeforePurge = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
const onAfterPurge = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);

class HookedService extends BaseTestService {
  protected async onAfterRestore(): Promise<void> { await onAfterRestore(); }
  protected async onBeforePurge(ids: string[]): Promise<void> { await onBeforePurge(ids as never); }
  protected async onAfterPurge(ids: string[]): Promise<void> { await onAfterPurge(ids as never); }
}

const tombstone: TestEntity = {
  id: 'id-1',
  orgId: 'org1',
  name: 'Gone',
  isDefault: false,
  createdAt: new Date(),
  updatedAt: new Date(),
  createdBy: 'u',
  updatedBy: 'u',
};

// Mock builders for each drizzle chain --------------------------------------
function mockUpdateReturning(rows: TestEntity[]) {
  mockUpdate.mockReturnValue({ set: jest.fn().mockReturnValue({ where: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue(rows) }) }) });
}
function mockSelectLimit(rows: unknown[]) {
  mockSelect.mockReturnValue({ from: jest.fn().mockReturnValue({ where: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue(rows) }) }) });
}
function mockSelectOrderLimitOffset(rows: unknown[]) {
  mockSelect.mockReturnValue({
    from: jest.fn().mockReturnValue({
      where: jest.fn().mockReturnValue({
        orderBy: jest.fn().mockReturnValue({ limit: jest.fn().mockReturnValue({ offset: jest.fn().mockResolvedValue(rows) }) }),
      }),
    }),
  });
}
// purgeExpired: select doomed ids, then delete().where().
function mockPurge(ids: string[]) {
  mockSelect.mockReturnValue({ from: jest.fn().mockReturnValue({ where: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue(ids.map((id) => ({ id }))) }) }) });
  mockDelete.mockReturnValue({ where: jest.fn().mockResolvedValue(undefined) });
}

beforeEach(() => { jest.clearAllMocks(); });

describe('CrudService.restore', () => {
  it('restores a tombstone (clears isActive/deletedAt/deletedBy/purgeAfter) and returns the row', async () => {
    const svc = new BaseTestService(lifecycleSchema);
    let capturedSet: Record<string, unknown> = {};
    mockUpdate.mockReturnValue({ set: jest.fn((v: Record<string, unknown>) => { capturedSet = v; return { where: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue([tombstone]) }) }; }) });

    const result = await svc.restore('id-1', 'org1', 'actor');

    expect(result).toEqual(tombstone);
    expect(capturedSet).toMatchObject({ isActive: true, deletedAt: null, deletedBy: null, purgeAfter: null, updatedBy: 'actor' });
  });

  it('returns null when no tombstone matched', async () => {
    const svc = new BaseTestService(lifecycleSchema);
    mockUpdateReturning([]);
    expect(await svc.restore('missing', 'org1', 'actor')).toBeNull();
  });

  it('no-ops (returns null) when the entity has no soft-delete columns', async () => {
    const svc = new BaseTestService(bareSchema);
    expect(await svc.restore('id-1', 'org1', 'actor')).toBeNull();
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('invokes onAfterRestore after a successful restore', async () => {
    const svc = new HookedService(lifecycleSchema);
    mockUpdateReturning([tombstone]);
    await svc.restore('id-1', 'org1', 'actor');
    expect(onAfterRestore).toHaveBeenCalledTimes(1);
  });
});

describe('CrudService.findDeletedById', () => {
  it('returns the tombstone row', async () => {
    const svc = new BaseTestService(lifecycleSchema);
    mockSelectLimit([tombstone]);
    expect(await svc.findDeletedById('id-1', 'org1')).toEqual(tombstone);
  });

  it('returns null when none found', async () => {
    const svc = new BaseTestService(lifecycleSchema);
    mockSelectLimit([]);
    expect(await svc.findDeletedById('id-1', 'org1')).toBeNull();
  });

  it('no-ops (returns null) when entity has no soft-delete columns', async () => {
    const svc = new BaseTestService(bareSchema);
    expect(await svc.findDeletedById('id-1', 'org1')).toBeNull();
    expect(mockSelect).not.toHaveBeenCalled();
  });
});

describe('CrudService.findDeleted', () => {
  it('lists tombstones for the org', async () => {
    const svc = new BaseTestService(lifecycleSchema);
    mockSelectOrderLimitOffset([tombstone]);
    expect(await svc.findDeleted('org1')).toEqual([tombstone]);
  });

  it('clamps limit to [1,200]', async () => {
    const svc = new BaseTestService(lifecycleSchema);
    const offsetFn = jest.fn<() => Promise<unknown[]>>().mockResolvedValue([]);
    const limitFn = jest.fn().mockReturnValue({ offset: offsetFn });
    mockSelect.mockReturnValue({ from: jest.fn().mockReturnValue({ where: jest.fn().mockReturnValue({ orderBy: jest.fn().mockReturnValue({ limit: limitFn }) }) }) });
    await svc.findDeleted('org1', { limit: 9999 });
    expect(limitFn).toHaveBeenCalledWith(200);
  });

  it('no-ops (returns []) when entity has no soft-delete columns', async () => {
    const svc = new BaseTestService(bareSchema);
    expect(await svc.findDeleted('org1')).toEqual([]);
    expect(mockSelect).not.toHaveBeenCalled();
  });
});

describe('CrudService.purgeExpired', () => {
  it('hard-deletes expired tombstones and returns the count', async () => {
    const svc = new BaseTestService(lifecycleSchema);
    mockPurge(['a', 'b', 'c']);
    const purged = await svc.purgeExpired(new Date(), 500);
    expect(purged).toBe(3);
    expect(mockDelete).toHaveBeenCalledTimes(1);
  });

  it('returns 0 and never deletes when nothing is expired', async () => {
    const svc = new BaseTestService(lifecycleSchema);
    mockPurge([]);
    expect(await svc.purgeExpired(new Date())).toBe(0);
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it('no-ops (returns 0) when entity lacks deletedAt/purgeAfter', async () => {
    const svc = new BaseTestService(bareSchema);
    expect(await svc.purgeExpired(new Date())).toBe(0);
    expect(mockSelect).not.toHaveBeenCalled();
  });

  it('runs onBeforePurge (inside the tx) then onAfterPurge with the purged ids', async () => {
    const svc = new HookedService(lifecycleSchema);
    mockPurge(['a', 'b']);
    await svc.purgeExpired(new Date());
    expect(onBeforePurge).toHaveBeenCalledWith(['a', 'b']);
    expect(onAfterPurge).toHaveBeenCalledWith(['a', 'b']);
  });
});
