// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Handler tests for routes/read-messages (inbox, announcements, conversations,
 * unread count, single message, thread).
 *
 * Single-message reads MUST use the viewer-scoped `findVisibleById`; the
 * unscoped `findById` is wired to throw so a regression to it fails loudly.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';
import {
  createMockQuotaService,
  forbiddenLookup,
  getHandler,
  mockReq,
  mockRes,
  routeApiCoreOverrides,
  routeApiServerMock,
} from './helpers/route-test-utils.js';

const mockFindPaginated = jest.fn<(...args: unknown[]) => unknown>();
const mockFindAnnouncements = jest.fn<(...args: unknown[]) => unknown>();
const mockFindConversations = jest.fn<(...args: unknown[]) => unknown>();
const mockGetUnreadCount = jest.fn<(...args: unknown[]) => unknown>();
const mockFindVisibleById = jest.fn<(...args: unknown[]) => unknown>();
const mockFindThreadMessages = jest.fn<(...args: unknown[]) => unknown>();

jest.unstable_mockModule('../src/services/message-service.js', () => ({
  messageService: {
    findPaginated: mockFindPaginated,
    findAnnouncements: mockFindAnnouncements,
    findConversations: mockFindConversations,
    getUnreadCount: mockGetUnreadCount,
    findVisibleById: mockFindVisibleById,
    findById: forbiddenLookup('findById'),
    findThreadMessages: mockFindThreadMessages,
  },
}));

// create-message + read-messages import attachmentService (which pulls in
// pipeline-data withTenantTx). Stub it.
const mockLinkToMessage = jest.fn<(...args: unknown[]) => Promise<unknown[]>>().mockResolvedValue([]);
jest.unstable_mockModule('../src/services/attachment-service.js', () => ({
  attachmentService: {
    linkToMessage: mockLinkToMessage,
    findByMessageId: jest.fn(async () => []),
    findByMessageIds: jest.fn(async () => []),
    findById: jest.fn(async () => null),
    createPending: jest.fn(),
  },
}));

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock(routeApiCoreOverrides()));
jest.unstable_mockModule('@pipeline-builder/api-server', () => routeApiServerMock());
jest.unstable_mockModule('@pipeline-builder/pipeline-data', () => ({
  schema: { message: { $inferInsert: {} } },
}));

const { sendBadRequest, sendEntityNotFound } = await import('@pipeline-builder/api-core');
const { createReadMessageRoutes } = await import('../src/routes/read-messages.js');

const mockQuotaService = createMockQuotaService();
const readRouter = createReadMessageRoutes(mockQuotaService);

describe('GET /messages (inbox)', () => {
  const handler = getHandler(readRouter, 'get', '/');

  beforeEach(() => jest.clearAllMocks());

  it('returns paginated messages', async () => {
    mockFindPaginated.mockResolvedValue({
      data: [{ id: '1', subject: 'Hello' }],
      total: 1,
      limit: 25,
      offset: 0,
      hasMore: false,
    });

    const req = mockReq();
    const res = mockRes();
    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: expect.arrayContaining([expect.objectContaining({ id: '1' })]),
        pagination: { limit: 25, offset: 0, hasMore: false, total: 1 },
      }),
    );
  });

  it('returns 500 on service error', async () => {
    mockFindPaginated.mockRejectedValue(new Error('DB error'));

    const req = mockReq();
    const res = mockRes();
    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
  });
});

describe('GET /messages/announcements', () => {
  const handler = getHandler(readRouter, 'get', '/announcements');

  beforeEach(() => jest.clearAllMocks());

  it('returns a paginated announcements page', async () => {
    const announcements = [{ id: '1', subject: 'System update', messageType: 'announcement' }];
    mockFindAnnouncements.mockResolvedValue({ data: announcements, total: 1, limit: 25, offset: 0, hasMore: false });

    const req = mockReq();
    const res = mockRes();
    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    // Now paginated + hard-capped (mirrors the `/` inbox): the service is called
    // with pagination options, and the response is a paginated envelope.
    expect(mockFindAnnouncements).toHaveBeenCalledWith(
      'org-1',
      expect.objectContaining({ limit: 25, offset: 0, sortBy: 'createdAt', sortOrder: 'desc' }),
    );
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: announcements,
        pagination: expect.objectContaining({ limit: 25, offset: 0, hasMore: false, total: 1 }),
      }),
    );
  });

  it('returns 500 on service error', async () => {
    mockFindAnnouncements.mockRejectedValue(new Error('DB error'));

    const req = mockReq();
    const res = mockRes();
    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
  });
});

describe('GET /messages/conversations', () => {
  const handler = getHandler(readRouter, 'get', '/conversations');

  beforeEach(() => jest.clearAllMocks());

  it('returns a paginated conversations page', async () => {
    const conversations = [{ id: '1', subject: 'Question', messageType: 'conversation' }];
    mockFindConversations.mockResolvedValue({ data: conversations, total: 1, limit: 25, offset: 0, hasMore: false });

    const req = mockReq();
    const res = mockRes();
    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    // Viewer is NOT passed positionally any more — per-user scoping (and the
    // viewer segment of the inbox cache key) both read the request's tenant
    // context, so the predicate and the cache key can't disagree about who is
    // asking. Asserting exactly two args pins that the parameter stays gone.
    expect(mockFindConversations).toHaveBeenCalledWith(
      'org-1',
      expect.objectContaining({ limit: 25, offset: 0, sortBy: 'createdAt', sortOrder: 'desc' }),
    );
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: conversations,
        pagination: expect.objectContaining({ limit: 25, offset: 0, hasMore: false, total: 1 }),
      }),
    );
  });
});

describe('GET /messages/unread/count', () => {
  const handler = getHandler(readRouter, 'get', '/unread/count');

  beforeEach(() => jest.clearAllMocks());

  it('returns unread count', async () => {
    mockGetUnreadCount.mockResolvedValue(5);

    const req = mockReq();
    const res = mockRes();
    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        data: expect.objectContaining({ count: 5 }),
      }),
    );
  });

  it('returns 500 on service error', async () => {
    mockGetUnreadCount.mockRejectedValue(new Error('DB error'));

    const req = mockReq();
    const res = mockRes();
    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
  });
});

describe('GET /messages/:id', () => {
  const handler = getHandler(readRouter, 'get', '/:id');

  beforeEach(() => jest.clearAllMocks());

  it('returns a message by ID', async () => {
    const message = { id: 'msg-1', subject: 'Hello' };
    mockFindVisibleById.mockResolvedValue(message);

    const req = mockReq({ params: { id: 'msg-1' } });
    const res = mockRes();
    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    // Viewer-scoped lookup (never the unscoped findById).
    expect(mockFindVisibleById).toHaveBeenCalledWith('msg-1', 'org-1');
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        data: expect.objectContaining({ message }),
      }),
    );
  });

  it('returns 404 when message not found', async () => {
    mockFindVisibleById.mockResolvedValue(null);

    const req = mockReq({ params: { id: 'nonexistent' } });
    const res = mockRes();
    await handler(req, res);

    expect(sendEntityNotFound).toHaveBeenCalledWith(res, 'Message');
  });

  it('returns 400 when ID param is missing', async () => {
    const req = mockReq({ params: {} });
    const res = mockRes();
    await handler(req, res);

    expect(sendBadRequest).toHaveBeenCalledWith(res, 'Message ID is required', 'MISSING_REQUIRED_FIELD');
  });

  it('returns 500 on service error', async () => {
    mockFindVisibleById.mockRejectedValue(new Error('DB error'));

    const req = mockReq({ params: { id: 'msg-1' } });
    const res = mockRes();
    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
  });
});

describe('GET /messages/:id/thread', () => {
  const handler = getHandler(readRouter, 'get', '/:id/thread');

  beforeEach(() => jest.clearAllMocks());

  it('returns thread messages sorted by date', async () => {
    const root = { id: 'msg-1', subject: 'Hello', createdAt: '2026-01-01T00:00:00Z' };
    const reply = { id: 'msg-2', subject: 'Hello', threadId: 'msg-1', createdAt: '2026-01-01T01:00:00Z' };
    mockFindVisibleById.mockResolvedValue(root);
    mockFindThreadMessages.mockResolvedValue([reply]);

    const req = mockReq({ params: { id: 'msg-1' } });
    const res = mockRes();
    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    // Thread root is loaded viewer-scoped (never the unscoped findById).
    expect(mockFindVisibleById).toHaveBeenCalledWith('msg-1', 'org-1');
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        data: expect.objectContaining({
          // Thread route now embeds per-message attachments (empty here).
          messages: [{ ...root, attachments: [] }, { ...reply, attachments: [] }],
        }),
      }),
    );
  });

  it('returns 404 when root message not found', async () => {
    mockFindVisibleById.mockResolvedValue(null);

    const req = mockReq({ params: { id: 'nonexistent' } });
    const res = mockRes();
    await handler(req, res);

    expect(sendEntityNotFound).toHaveBeenCalledWith(res, 'Thread');
  });

  it('returns 400 when ID param is missing', async () => {
    const req = mockReq({ params: {} });
    const res = mockRes();
    await handler(req, res);

    expect(sendBadRequest).toHaveBeenCalledWith(res, 'Message ID is required', 'MISSING_REQUIRED_FIELD');
  });
});
