// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

// Mock external dependencies — must be set up before importing the service
const mockFind = jest.fn();
const mockUpdate = jest.fn();
const mockUpdateMany = jest.fn();
const mockCount = jest.fn();

jest.mock('@pipeline-builder/pipeline-core', () => {
  class MockCrudService {
    find = mockFind;
    update = mockUpdate;
    updateMany = mockUpdateMany;
    count = mockCount;
  }

  return {
    CrudService: MockCrudService,
    CoreConstants: { CACHE_TTL_MESSAGE: 300 },
    buildMessageConditions: jest.fn(() => []),
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
        isRead: 'isRead',
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

  describe('markAsRead', () => {
    it('should call update with isRead: true', async () => {
      const updated = { id: 'msg-1', isRead: true };
      mockUpdate.mockResolvedValueOnce(updated);

      const result = await service.markAsRead('msg-1', 'org-1', 'user-1');

      expect(mockUpdate).toHaveBeenCalledWith('msg-1', { isRead: true }, 'org-1', 'user-1');
      expect(result).toEqual(updated);
    });

    it('should return null when message not found', async () => {
      mockUpdate.mockResolvedValueOnce(null);

      const result = await service.markAsRead('nonexistent', 'org-1', 'user-1');
      expect(result).toBeNull();
    });
  });

  describe('markThreadAsRead', () => {
    it('should call updateMany with threadId and isRead filter', async () => {
      const updated = [
        { id: 'msg-2', isRead: true },
        { id: 'msg-3', isRead: true },
      ];
      mockUpdateMany.mockResolvedValueOnce(updated);

      const result = await service.markThreadAsRead('root-1', 'org-1', 'user-1');

      expect(mockUpdateMany).toHaveBeenCalledWith(
        { threadId: 'root-1', isRead: false },
        { isRead: true },
        'org-1',
        'user-1',
      );
      expect(result).toEqual(updated);
    });
  });

  describe('getUnreadCount', () => {
    it('should call count with isActive and isRead: false filter', async () => {
      mockCount.mockResolvedValueOnce(5);

      const result = await service.getUnreadCount('org-1');

      expect(mockCount).toHaveBeenCalledWith(
        { isActive: true, isRead: false },
        'org-1',
      );
      expect(result).toBe(5);
    });

    it('should return 0 when no unread messages', async () => {
      mockCount.mockResolvedValueOnce(0);

      const result = await service.getUnreadCount('org-1');
      expect(result).toBe(0);
    });
  });

  describe('getSortColumn', () => {
    it('should return a column for valid sortBy values', () => {
      const validFields = ['id', 'createdAt', 'updatedAt', 'subject', 'messageType', 'priority', 'isRead'];

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
