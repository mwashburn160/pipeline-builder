// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

// Mock external dependencies — must be set up before importing the service
const mockFind = jest.fn<(...args: unknown[]) => unknown>();
const mockFindPaginated = jest.fn<(...args: unknown[]) => unknown>();
const mockDbUpdate = jest.fn<(...args: unknown[]) => unknown>();
const mockDbSelect = jest.fn<(...args: unknown[]) => unknown>();
// Shared spy for the centralized participant/visibility builder. markAsRead,
// markThreadAsRead and getUnreadCount now route their WHERE through
// `buildMessageConditions` (via CrudService.buildConditions) instead of an inline
// or(orgId,recipientOrgId,'*') — tests assert the builder is invoked with the
// right filter, which is where the system-org "sees all" carve-out lives.
const mockBuildMessageConditions = jest.fn((_filter: unknown, _orgId: string): unknown[] => []);

// The real `@pipeline-builder/api-core` barrel only re-exports a stale built
// `createCacheService`; mock it with a pass-through cache so reads still hit the
// underlying service methods (getOrSet invokes its loader) and invalidation is a no-op.
// message-service imports deleteAttachments from attachment-storage (which pulls
// in the S3 SDK + api-core env helpers). Stub it so the service loads cleanly.
const mockDeleteAttachments = jest.fn<(keys: string[]) => Promise<string[]>>(async () => []);
jest.unstable_mockModule('../src/services/attachment-storage.js', () => ({
  deleteAttachments: mockDeleteAttachments,
}));

// Purge-transaction harness. `purgeById` on the mock base class below follows
// the REAL CrudService.purgeById contract: onBeforePurge(ids, tx) and the parent
// DELETE run inside one transaction; onAfterPurge(ids) runs ONLY after it
// commits. `mockParentDelete` rejecting models a failed parent DELETE / commit,
// i.e. a rollback that resurrects every row the hook deleted.
const mockParentDelete = jest.fn<(ids: string[]) => Promise<void>>(async () => undefined);
const mockAttachmentDeleteReturning = jest.fn<() => Promise<Array<{ messageId: string | null; storageKey: string }>>>(async () => []);
const purgeTx = {
  delete: jest.fn(() => ({ where: jest.fn(() => ({ returning: mockAttachmentDeleteReturning })) })),
};

// Spy on the cache KEY as well as passing through to the loader — the inbox
// key carries the viewer segment, and a key collision between two users is a
// cross-user read, so it needs to be assertable.
const mockCacheGetOrSet = jest.fn((_key: string, loader: () => unknown) => loader());

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  createCacheService: () => ({
    get: jest.fn(),
    set: jest.fn(),
    del: jest.fn(),
    invalidate: jest.fn(),
    invalidatePattern: jest.fn<(...args: unknown[]) => Promise<void>>().mockResolvedValue(undefined),
    getOrSet: (key: string, loader: () => unknown) => mockCacheGetOrSet(key, loader),
  }),
}));

jest.unstable_mockModule('@pipeline-builder/pipeline-core', () => {
  class MockCrudService {
    find = mockFind;
    findPaginated = mockFindPaginated;
    purgeAfterStamp() { return {}; }
  }

  return {
    CrudService: MockCrudService,
    CoreConstants: { CACHE_TTL_MESSAGE: 300 },
    buildMessageConditions: (f: unknown, o: string) => mockBuildMessageConditions(f, o),
    // Viewer plumbing: the service stamps the request's viewer onto every filter
    // via `withViewerContext` and keys the inbox cache off `currentViewerUserId`.
    // These stubs make both a no-op/`undefined` so the existing assertions on the
    // filter shape stay exact; the viewer behavior itself is covered in
    // pipeline-data's viewer-context tests.
    withViewerContext: (f: unknown) => mockWithViewerContext(f),
    currentViewerUserId: () => mockCurrentViewerUserId(),
    // message-service.{markAsRead,markThreadAsRead,getUnreadCount,deleteThread}
    // were migrated to withTenantTx — pass through the same spies the test
    // already tracks (mockDbUpdate / mockDbSelect).
    withTenantTx: (fn: (tx: unknown) => unknown) => fn({
      update: mockDbUpdate,
      select: mockDbSelect,
    }),
    schema: {
      message: {
        id: 'id',
        orgId: 'orgId',
        recipientOrgId: 'recipientOrgId',
        threadId: 'threadId',
        messageType: 'messageType',
        subject: 'subject',
        content: 'content',
        priority: 'priority',
        readBy: 'readBy',
        isActive: 'isActive',
        createdAt: 'createdAt',
        updatedAt: 'updatedAt',
        createdBy: 'createdBy',
        updatedBy: 'updatedBy',
        visibility: 'visibility',
      },
    },
  };
});
// Viewer plumbing. Kept as an identity passthrough so the filter-shape
// assertions below stay exact — what matters is that EVERY predicate is routed
// through it, which `routes every filter through the viewer stamp` pins.
const mockWithViewerContext = jest.fn((f: unknown) => f);
const mockCurrentViewerUserId = jest.fn((): string | undefined => undefined);

jest.unstable_mockModule('@pipeline-builder/pipeline-data', () => {
  class MockCrudService {
    find = mockFind;
    findPaginated = mockFindPaginated;
    purgeAfterStamp() { return {}; }
    protected async onBeforePurge(_ids: string[], _tx: unknown): Promise<void> {}
    protected async onAfterPurge(_ids: string[]): Promise<void> {}
    async purgeById(id: string): Promise<string | null> {
      const purged = await (async () => {
        await this.onBeforePurge([id], purgeTx);
        await mockParentDelete([id]);
        return id;
      })();
      await this.onAfterPurge([purged]);
      return purged;
    }
  }

  return {
    CrudService: MockCrudService,
    CoreConstants: { CACHE_TTL_MESSAGE: 300 },
    buildMessageConditions: (f: unknown, o: string) => mockBuildMessageConditions(f, o),
    // Viewer plumbing: the service stamps the request's viewer onto every filter
    // via `withViewerContext` and keys the inbox cache off `currentViewerUserId`.
    // These stubs make both a no-op/`undefined` so the existing assertions on the
    // filter shape stay exact; the viewer behavior itself is covered in
    // pipeline-data's viewer-context tests.
    withViewerContext: (f: unknown) => mockWithViewerContext(f),
    currentViewerUserId: () => mockCurrentViewerUserId(),
    // message-service.{markAsRead,markThreadAsRead,getUnreadCount,deleteThread}
    // were migrated to withTenantTx — pass through the same spies the test
    // already tracks (mockDbUpdate / mockDbSelect).
    withTenantTx: (fn: (tx: unknown) => unknown) => fn({
      update: mockDbUpdate,
      select: mockDbSelect,
    }),
    schema: {
      messageAttachment: { messageId: 'messageId', storageKey: 'storageKey' },
      message: {
        id: 'id',
        orgId: 'orgId',
        recipientOrgId: 'recipientOrgId',
        threadId: 'threadId',
        messageType: 'messageType',
        subject: 'subject',
        content: 'content',
        priority: 'priority',
        readBy: 'readBy',
        isActive: 'isActive',
        createdAt: 'createdAt',
        updatedAt: 'updatedAt',
        createdBy: 'createdBy',
        updatedBy: 'updatedBy',
        visibility: 'visibility',
      },
    },
  };
});;

jest.unstable_mockModule('drizzle-orm', () => ({
  SQL: class {},
  or: jest.fn((...args: any[]) => args),
  ilike: jest.fn((col: any, val: any) => ({ col, val, op: 'ilike' })),
  eq: jest.fn((col: any, val: any) => ({ col, val, op: 'eq' })),
  and: jest.fn((...args: any[]) => args),
  inArray: jest.fn((col: any, vals: any) => ({ col, vals, op: 'inArray' })),
  sql: Object.assign(
    jest.fn((..._args: any[]) => ({ _kind: 'sql' })),
    { [Symbol.for('drizzle.sql')]: true },
  ),
}));

jest.unstable_mockModule('drizzle-orm/column', () => ({}));
jest.unstable_mockModule('drizzle-orm/pg-core', () => ({}));

const { MessageService } = await import('../src/services/message-service.js');

// Tests

describe('MessageService', () => {
  let service: InstanceType<typeof MessageService>;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new MessageService();
  });

  describe('findThreadMessages', () => {
    it('should call find with threadId and isActive filter', async () => {
      const expected = [{ id: '2', threadId: 'root-1', content: 'reply' }];
      mockFind.mockResolvedValueOnce(expected);

      const result = await service.findThreadMessages('root-1', 'org-1');

      expect(mockFind).toHaveBeenCalledWith(
        { threadId: 'root-1', isActive: true },
        'org-1',
      );
      expect(result).toEqual(expected);
    });

    it('should return empty array when no thread messages found', async () => {
      mockFind.mockResolvedValueOnce([]);

      const result = await service.findThreadMessages('nonexistent', 'org-1');
      expect(result).toEqual([]);
    });
  });

  // findInboxPaginated / findAnnouncements / findConversations are now PAGINATED
  // and hard-capped: they route through findPaginated (which clamps limit to
  // MAX_PAGE_LIMIT), replacing the old unbounded find(...) that cached whole sets.
  const paginated = (data: unknown[], over: Record<string, unknown> = {}) =>
    ({ data, limit: 25, offset: 0, hasMore: false, ...over });

  describe('findInboxPaginated', () => {
    it('delegates to findPaginated with threadId:null + messageType + options', async () => {
      const page = paginated([{ id: '1', threadId: null, subject: 'Root message' }]);
      mockFindPaginated.mockResolvedValueOnce(page);

      const result = await service.findInboxPaginated('org-1', 'announcement', { limit: 25, offset: 0, sortBy: 'createdAt', sortOrder: 'desc' });

      expect(mockFindPaginated).toHaveBeenCalledWith(
        { isActive: true, threadId: null, messageType: 'announcement' },
        'org-1',
        { limit: 25, offset: 0, sortBy: 'createdAt', sortOrder: 'desc' },
      );
      expect(result).toEqual(page);
    });

    it('threads conversation type through', async () => {
      mockFindPaginated.mockResolvedValueOnce(paginated([]));

      await service.findInboxPaginated('org-1', 'conversation', {});

      expect(mockFindPaginated).toHaveBeenCalledWith(
        { isActive: true, threadId: null, messageType: 'conversation' },
        'org-1',
        {},
      );
    });
  });

  describe('findAnnouncements', () => {
    it('returns a paginated page of announcements via findPaginated', async () => {
      const page = paginated([{ id: 'a1', messageType: 'announcement' }]);
      mockFindPaginated.mockResolvedValueOnce(page);

      const result = await service.findAnnouncements('org-1', { limit: 25, offset: 0 });

      expect(mockFindPaginated).toHaveBeenCalledWith(
        { isActive: true, threadId: null, messageType: 'announcement' },
        'org-1',
        { limit: 25, offset: 0 },
      );
      expect(result).toEqual(page);
    });
  });

  describe('findConversations', () => {
    it('returns a paginated page of conversations via findPaginated', async () => {
      const page = paginated([{ id: 'c1', messageType: 'conversation' }]);
      mockFindPaginated.mockResolvedValueOnce(page);

      const result = await service.findConversations('org-1', { limit: 25, offset: 0 });

      expect(mockFindPaginated).toHaveBeenCalledWith(
        { isActive: true, threadId: null, messageType: 'conversation' },
        'org-1',
        { limit: 25, offset: 0 },
      );
      expect(result).toEqual(page);
    });
  });

  // markAsRead / markThreadAsRead / getUnreadCount now hit `db` directly
  // (instead of going through the inherited update/updateMany/count) because
  // they need to write the per-org `readBy` jsonb column with raw SQL.
  // Tests assert on the db chain rather than the service base methods.

  describe('markAsRead', () => {
    it('upserts readBy[orgId] for the calling org', async () => {
      const updated = { id: 'msg-1', readBy: { 'org-1': '2026-04-27T00:00:00Z' } };
      const returningFn = jest.fn<() => Promise<unknown>>().mockResolvedValue([updated]);
      const whereFn = jest.fn().mockReturnValue({ returning: returningFn });
      const setFn = jest.fn().mockReturnValue({ where: whereFn });
      mockDbUpdate.mockReturnValue({ set: setFn });

      const result = await service.markAsRead('msg-1', 'org-1', 'user-1');

      expect(mockDbUpdate).toHaveBeenCalled();
      expect(setFn).toHaveBeenCalledWith(expect.objectContaining({
        updatedBy: 'user-1',
      }));
      expect(result).toEqual(updated);
    });

    // Wire the fallback existence SELECT: tx.select().from().where().limit() → rows
    const wireExistenceSelect = (rows: unknown[]) => mockDbSelect.mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          limit: jest.fn<() => Promise<unknown>>().mockResolvedValue(rows),
        }),
      }),
    });

    it('should return null when message not found', async () => {
      const returningFn = jest.fn<() => Promise<unknown>>().mockResolvedValue([]);
      mockDbUpdate.mockReturnValue({
        set: jest.fn().mockReturnValue({ where: jest.fn().mockReturnValue({ returning: returningFn }) }),
      });
      wireExistenceSelect([]); // fallback finds nothing → truly not found

      const result = await service.markAsRead('nonexistent', 'org-1', 'user-1');
      expect(result).toBeNull();
    });

    it('is idempotent: returns the message (not null) when it exists but is already read', async () => {
      const returningFn = jest.fn<() => Promise<unknown>>().mockResolvedValue([]);
      mockDbUpdate.mockReturnValue({
        set: jest.fn().mockReturnValue({ where: jest.fn().mockReturnValue({ returning: returningFn }) }),
      });
      const existing = { id: 'msg-1', readBy: { 'org-1': '2026-04-27T00:00:00Z' } };
      wireExistenceSelect([existing]);

      const result = await service.markAsRead('msg-1', 'org-1', 'user-1');
      expect(result).toEqual(existing);
    });

    // A soft-deleted (isActive=false) message must not be mutable or returnable
    // via markAsRead. The participant + isActive + id predicate now comes from the
    // SHARED buildMessageConditions (via buildConditions) — the same builder the
    // read paths use, so system-org "sees all" applies consistently. We assert the
    // builder is invoked with {id, isActive:true} rather than an inline isActive eq.
    it('routes the update predicate through buildMessageConditions with {id, isActive:true}', async () => {
      const returningFn = jest.fn<() => Promise<unknown>>().mockResolvedValue([{ id: 'msg-1' }]);
      const whereFn = jest.fn().mockReturnValue({ returning: returningFn });
      mockDbUpdate.mockReturnValue({ set: jest.fn().mockReturnValue({ where: whereFn }) });

      await service.markAsRead('msg-1', 'org-1', 'user-1');

      expect(mockBuildMessageConditions).toHaveBeenCalledWith(
        { id: 'msg-1', isActive: true },
        'org-1',
      );
    });

    it('routes the fallback existence select through buildMessageConditions with {id, isActive:true}', async () => {
      const returningFn = jest.fn<() => Promise<unknown>>().mockResolvedValue([]); // update matched nothing
      mockDbUpdate.mockReturnValue({
        set: jest.fn().mockReturnValue({ where: jest.fn().mockReturnValue({ returning: returningFn }) }),
      });
      const selectWhere = jest.fn().mockReturnValue({
        limit: jest.fn<() => Promise<unknown>>().mockResolvedValue([]),
      });
      mockDbSelect.mockReturnValue({ from: jest.fn().mockReturnValue({ where: selectWhere }) });

      await service.markAsRead('msg-1', 'org-1', 'user-1');

      // Called for both the update predicate and the fallback existence select,
      // each with the shared {id, isActive:true} filter. The viewer is no longer
      // an explicit key here — it arrives via the withViewerContext stamp.
      expect(mockBuildMessageConditions).toHaveBeenCalledWith(
        { id: 'msg-1', isActive: true },
        'org-1',
      );
      expect(mockBuildMessageConditions).toHaveBeenCalledTimes(2);
    });
  });

  describe('markThreadAsRead', () => {
    it('upserts readBy[orgId] across the thread for the caller only', async () => {
      const updated = [
        { id: 'msg-2', readBy: { 'org-1': '2026-04-27T00:00:00Z' } },
        { id: 'msg-3', readBy: { 'org-1': '2026-04-27T00:00:00Z' } },
      ];
      const returningFn = jest.fn<() => Promise<unknown>>().mockResolvedValue(updated);
      const whereFn = jest.fn().mockReturnValue({ returning: returningFn });
      const setFn = jest.fn().mockReturnValue({ where: whereFn });
      mockDbUpdate.mockReturnValue({ set: setFn });

      const result = await service.markThreadAsRead('root-1', 'org-1', 'user-1');

      expect(mockDbUpdate).toHaveBeenCalled();
      expect(setFn).toHaveBeenCalledWith(expect.objectContaining({
        updatedBy: 'user-1',
      }));
      expect(result).toEqual(updated);
      // Participant predicate centralized through the shared builder (thread-scoped),
      // scoped to the calling user for per-user targeted rows.
      expect(mockBuildMessageConditions).toHaveBeenCalledWith(
        { threadId: 'root-1', isActive: true },
        'org-1',
      );
    });
  });

  describe('getUnreadCount', () => {
    it('counts messages where readBy lacks the orgId key', async () => {
      const whereFn = jest.fn<() => Promise<unknown>>().mockResolvedValue([{ count: 5 }]);
      const fromFn = jest.fn().mockReturnValue({ where: whereFn });
      mockDbSelect.mockReturnValue({ from: fromFn });

      const result = await service.getUnreadCount('org-1');

      expect(mockDbSelect).toHaveBeenCalled();
      expect(result).toBe(5);
      // Participant predicate centralized through the shared builder — so the
      // unread count can't diverge from what the org can actually read.
      expect(mockBuildMessageConditions).toHaveBeenCalledWith(
        { isActive: true },
        'org-1',
      );
    });

    it('should return 0 when no unread messages', async () => {
      const whereFn = jest.fn<() => Promise<unknown>>().mockResolvedValue([{ count: 0 }]);
      mockDbSelect.mockReturnValue({ from: jest.fn().mockReturnValue({ where: whereFn }) });

      const result = await service.getUnreadCount('org-1');
      expect(result).toBe(0);
    });
  });

  describe('getSortColumn', () => {
    it('should return a column for valid sortBy values', () => {
      const validFields = ['id', 'createdAt', 'updatedAt', 'subject', 'messageType', 'priority'];

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

  // deleteThread cascades soft-delete to all replies in a thread. Tenancy
  // matters: replies can be authored by either party, so the WHERE clause
  // must scope by `orgId == caller OR recipientOrgId == caller`. Without
  // that filter, a delete-thread call on a guessed UUID could cross tenants.
  describe('deleteThread', () => {
    it('soft-deletes thread replies scoped to the caller org', async () => {
      // deleteThread doesn't call .returning() — the .where() resolves directly.
      const whereFn = jest.fn<() => Promise<unknown>>().mockResolvedValue(undefined);
      const setFn = jest.fn().mockReturnValue({ where: whereFn });
      mockDbUpdate.mockReturnValue({ set: setFn });

      await service.deleteThread('thread-root-1', 'user-1', 'org-1');

      expect(mockDbUpdate).toHaveBeenCalled();
      expect(setFn).toHaveBeenCalledWith(expect.objectContaining({
        isActive: false,
        deletedBy: 'user-1',
        updatedBy: 'user-1',
      }));
      // The where clause is composed of and(threadId, isActive, or(orgId|recipientOrgId)).
      // We verify the chain was reached, not the SQL shape (drizzle internals).
      expect(whereFn).toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Viewer plumbing
  // -------------------------------------------------------------------------
  //
  // Per-user targeting used to be hand-threaded: each read method took an
  // optional `viewerUserId` and forwarded it. That failed OPEN — a call site
  // that forgot the argument silently widened the read to every org-wide row,
  // which is how the post-mark-read unread counts ended up counting messages
  // addressed to OTHER users. The viewer now rides the request's tenant context
  // and is stamped in `buildConditions`, so these tests pin the two properties
  // that make the scheme safe: no predicate can bypass the stamp, and the inbox
  // cache key reads the SAME source the predicate does.

  describe('viewer scoping', () => {
    it('feeds the stamped filter into the predicate builder, never the raw one', async () => {
      // `find`/`findPaginated` are stubbed on the mock base class, so the paths
      // that reach buildConditions in this harness are the ones that call it
      // DIRECTLY — exactly the hand-rolled write predicates that used to carry
      // their own `viewerUserId` argument.
      mockWithViewerContext.mockImplementation((f: unknown) => ({ ...(f as object), viewerUserId: 'stamped' }));
      mockDbSelect.mockReturnValue({
        from: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([{ count: 0 }]) }),
      });
      mockDbUpdate.mockReturnValue({
        set: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({ returning: jest.fn<() => Promise<unknown>>().mockResolvedValue([]) }),
        }),
      });

      await service.getUnreadCount('org-1');
      await service.markThreadAsRead('root-1', 'org-1', 'user-1');

      // Every predicate built passed through the stamp first…
      expect(mockWithViewerContext).toHaveBeenCalledTimes(mockBuildMessageConditions.mock.calls.length);
      expect(mockBuildMessageConditions.mock.calls.length).toBeGreaterThanOrEqual(2);
      // …and it is the stamp's OUTPUT that reaches the builder, not the input.
      for (const [filter] of mockBuildMessageConditions.mock.calls) {
        expect(filter).toEqual(expect.objectContaining({ viewerUserId: 'stamped' }));
      }
    });

    it('no longer accepts a viewer argument on the read methods', () => {
      // Arity is the guard: re-adding an optional viewer parameter would let a
      // call site drop it again and silently widen the read.
      expect(service.findVisibleById).toHaveLength(2);
      expect(service.findThreadMessages).toHaveLength(2);
      expect(service.getUnreadCount).toHaveLength(1);
    });

    it('keys the conversations cache on the viewer from the tenant context', async () => {
      mockFindPaginated.mockResolvedValue({ data: [], total: 0, limit: 25, offset: 0, hasMore: false });

      mockCurrentViewerUserId.mockReturnValue('user-a');
      await service.findConversations('org-1', { limit: 25, offset: 0 });
      mockCurrentViewerUserId.mockReturnValue('user-b');
      await service.findConversations('org-1', { limit: 25, offset: 0 });

      // Two DIFFERENT viewers on identical org+page must not share a cache entry —
      // a collision here would serve user A's per-user targeted rows to user B.
      const keys = mockCacheGetOrSet.mock.calls.map((c) => c[0]);
      expect(keys).toHaveLength(2);
      expect(keys[0]).not.toEqual(keys[1]);
      expect(keys[0]).toContain('user-a');
      expect(keys[1]).toContain('user-b');
    });

    it('keeps the announcements cache shared per-org (never user-targeted)', async () => {
      mockFindPaginated.mockResolvedValue({ data: [], total: 0, limit: 25, offset: 0, hasMore: false });

      mockCurrentViewerUserId.mockReturnValue('user-a');
      await service.findAnnouncements('org-1', { limit: 25, offset: 0 });
      mockCurrentViewerUserId.mockReturnValue('user-b');
      await service.findAnnouncements('org-1', { limit: 25, offset: 0 });

      const keys = mockCacheGetOrSet.mock.calls.map((c) => c[0]);
      expect(keys[0]).toEqual(keys[1]);
      expect(keys[0]).not.toContain('user-a');
    });
  });

  // -------------------------------------------------------------------------
  // Hard-purge attachment teardown ordering
  // -------------------------------------------------------------------------
  describe('purge attachment teardown', () => {
    beforeEach(() => {
      mockParentDelete.mockReset().mockResolvedValue(undefined);
      mockAttachmentDeleteReturning.mockReset().mockResolvedValue([
        { messageId: 'msg-1', storageKey: 'org-1/att-1/a.png' },
        { messageId: 'msg-1', storageKey: 'org-1/att-2/b.pdf' },
      ]);
    });

    it('deletes blobs only AFTER the purge transaction commits', async () => {
      const order: string[] = [];
      mockParentDelete.mockImplementation(async () => { order.push('parent-delete'); });
      mockDeleteAttachments.mockImplementation(async () => { order.push('blob-delete'); return []; });

      await expect(service.purgeById('msg-1')).resolves.toBe('msg-1');

      expect(order).toEqual(['parent-delete', 'blob-delete']);
      expect(mockDeleteAttachments).toHaveBeenCalledTimes(1);
      expect(mockDeleteAttachments).toHaveBeenCalledWith(expect.arrayContaining(['org-1/att-1/a.png', 'org-1/att-2/b.pdf']));
    });

    it('never touches blobs when the purge transaction rolls back (rows resurrect intact)', async () => {
      mockParentDelete.mockRejectedValue(new Error('commit failed'));

      await expect(service.purgeById('msg-1')).rejects.toThrow('commit failed');

      expect(mockDeleteAttachments).not.toHaveBeenCalled();
    });

    it('a retry after a rollback still reclaims the blobs exactly once', async () => {
      mockParentDelete.mockRejectedValueOnce(new Error('commit failed'));
      await expect(service.purgeById('msg-1')).rejects.toThrow('commit failed');

      await service.purgeById('msg-1');
      expect(mockDeleteAttachments).toHaveBeenCalledTimes(1);
      const keys = mockDeleteAttachments.mock.calls[0][0];
      expect([...keys].sort()).toEqual(['org-1/att-1/a.png', 'org-1/att-2/b.pdf']);

      // Consumed: a later purge of the same id has nothing stale to re-delete.
      mockAttachmentDeleteReturning.mockResolvedValue([]);
      await service.purgeById('msg-1');
      expect(mockDeleteAttachments.mock.calls[1][0]).toEqual([]);
    });
  });
});
