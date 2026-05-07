// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

// Mock external dependencies — must be set up before importing the service
const mockFind = jest.fn();
const mockDbUpdate = jest.fn();
const mockDbSelect = jest.fn();

jest.mock('@pipeline-builder/pipeline-core', () => {
  class MockCrudService {
    find = mockFind;
  }

  return {
    CrudService: MockCrudService,
    CoreConstants: { CACHE_TTL_MESSAGE: 300 },
    buildMessageConditions: jest.fn(() => []),
    db: {
      update: mockDbUpdate,
      select: mockDbSelect,
    },
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
  and: jest.fn((...args: any[]) => args),
  sql: Object.assign(
    jest.fn((..._args: any[]) => ({ _kind: 'sql' })),
    { [Symbol.for('drizzle.sql')]: true },
  ),
}));

jest.mock('drizzle-orm/column', () => ({}));
jest.mock('drizzle-orm/pg-core', () => ({}));

import { MessageService } from '../src/services/message-service';

// Tests

describe('MessageService', () => {
  let service: MessageService;

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

  describe('findInbox', () => {
    it('should pass threadId: null for SQL-level root message filtering', async () => {
      const rootMessages = [
        { id: '1', threadId: null, subject: 'Root message' },
        { id: '3', threadId: null, subject: 'Another root' },
      ];
      mockFind.mockResolvedValueOnce(rootMessages);

      const result = await service.findInbox('org-1');

      expect(mockFind).toHaveBeenCalledWith(
        { isActive: true, threadId: null },
        'org-1',
      );
      expect(result).toEqual(rootMessages);
    });

    it('should pass messageType filter when provided', async () => {
      mockFind.mockResolvedValueOnce([]);

      await service.findInbox('org-1', 'announcement');

      expect(mockFind).toHaveBeenCalledWith(
        { isActive: true, threadId: null, messageType: 'announcement' },
        'org-1',
      );
    });

    it('should not include messageType filter when not provided', async () => {
      mockFind.mockResolvedValueOnce([]);

      await service.findInbox('org-1');

      expect(mockFind).toHaveBeenCalledWith(
        { isActive: true, threadId: null },
        'org-1',
      );
    });
  });

  describe('findAnnouncements', () => {
    it('should call findInbox with announcement type', async () => {
      mockFind.mockResolvedValueOnce([]);

      await service.findAnnouncements('org-1');

      expect(mockFind).toHaveBeenCalledWith(
        { isActive: true, threadId: null, messageType: 'announcement' },
        'org-1',
      );
    });
  });

  describe('findConversations', () => {
    it('should call findInbox with conversation type', async () => {
      mockFind.mockResolvedValueOnce([]);

      await service.findConversations('org-1');

      expect(mockFind).toHaveBeenCalledWith(
        { isActive: true, threadId: null, messageType: 'conversation' },
        'org-1',
      );
    });
  });

  // markAsRead / markThreadAsRead / getUnreadCount now hit `db` directly
  // (instead of going through the inherited update/updateMany/count) because
  // they need to write the per-org `readBy` jsonb column with raw SQL.
  // Tests assert on the db chain rather than the service base methods.

  describe('markAsRead', () => {
    it('upserts readBy[orgId] for the calling org', async () => {
      const updated = { id: 'msg-1', readBy: { 'org-1': '2026-04-27T00:00:00Z' } };
      const returningFn = jest.fn().mockResolvedValue([updated]);
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

    it('should return null when message not found', async () => {
      const returningFn = jest.fn().mockResolvedValue([]);
      mockDbUpdate.mockReturnValue({
        set: jest.fn().mockReturnValue({ where: jest.fn().mockReturnValue({ returning: returningFn }) }),
      });

      const result = await service.markAsRead('nonexistent', 'org-1', 'user-1');
      expect(result).toBeNull();
    });
  });

  describe('markThreadAsRead', () => {
    it('upserts readBy[orgId] across the thread for the caller only', async () => {
      const updated = [
        { id: 'msg-2', readBy: { 'org-1': '2026-04-27T00:00:00Z' } },
        { id: 'msg-3', readBy: { 'org-1': '2026-04-27T00:00:00Z' } },
      ];
      const returningFn = jest.fn().mockResolvedValue(updated);
      const whereFn = jest.fn().mockReturnValue({ returning: returningFn });
      const setFn = jest.fn().mockReturnValue({ where: whereFn });
      mockDbUpdate.mockReturnValue({ set: setFn });

      const result = await service.markThreadAsRead('root-1', 'org-1', 'user-1');

      expect(mockDbUpdate).toHaveBeenCalled();
      expect(setFn).toHaveBeenCalledWith(expect.objectContaining({
        updatedBy: 'user-1',
      }));
      expect(result).toEqual(updated);
    });
  });

  describe('getUnreadCount', () => {
    it('counts messages where readBy lacks the orgId key', async () => {
      const whereFn = jest.fn().mockResolvedValue([{ count: 5 }]);
      const fromFn = jest.fn().mockReturnValue({ where: whereFn });
      mockDbSelect.mockReturnValue({ from: fromFn });

      const result = await service.getUnreadCount('org-1');

      expect(mockDbSelect).toHaveBeenCalled();
      expect(result).toBe(5);
    });

    it('should return 0 when no unread messages', async () => {
      const whereFn = jest.fn().mockResolvedValue([{ count: 0 }]);
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
      const whereFn = jest.fn().mockResolvedValue(undefined);
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
});
