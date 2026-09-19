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

const { sendBadRequest, sendEntityNotFound, validateQuery, parsePaginationParams } = await import('@pipeline-builder/api-core');
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
      undefined, // no `search` term on this request
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
    // asking. The third arg is the optional free-text `search` (absent here) —
    // never a viewer, which pins that the parameter stays gone.
    expect(mockFindConversations).toHaveBeenCalledWith(
      'org-1',
      expect.objectContaining({ limit: 25, offset: 0, sortBy: 'createdAt', sortOrder: 'desc' }),
      undefined,
    );
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: conversations,
        pagination: expect.objectContaining({ limit: 25, offset: 0, hasMore: false, total: 1 }),
      }),
    );
  });
});

/**
 * The tab endpoints are the whole point of the messages page's Announcements /
 * Conversations tabs: each is filtered and PAGINATED server-side. Previously the
 * page filtered `messageType` client-side over the already-paginated mixed
 * inbox, so a tab showed only what the loaded pages happened to contain.
 */
describe('tab endpoints are independently filtered + paginated', () => {
  const announcements = getHandler(readRouter, 'get', '/announcements');
  const conversations = getHandler(readRouter, 'get', '/conversations');

  beforeEach(() => jest.clearAllMocks());

  it('reports the SERVER-side total for the tab, not the page size', async () => {
    // 2 rows on this page but 97 announcements in the org: the envelope must
    // carry the real total so the UI can render a truthful count.
    mockFindAnnouncements.mockResolvedValue({
      data: [{ id: 'a1' }, { id: 'a2' }],
      total: 97,
      limit: 2,
      offset: 0,
      hasMore: true,
    });

    const res = mockRes();
    await announcements(mockReq(), res);

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ pagination: expect.objectContaining({ total: 97, hasMore: true }) }),
    );
  });

  it('pages the tab on its OWN offset (not the mixed inbox\'s)', async () => {
    (parsePaginationParams as unknown as jest.Mock).mockReturnValueOnce({ limit: 25, offset: 50, sortBy: 'createdAt', sortOrder: 'desc' });
    mockFindConversations.mockResolvedValue({ data: [], total: 60, limit: 25, offset: 50, hasMore: false });

    await conversations(mockReq(), mockRes());

    expect(mockFindConversations).toHaveBeenCalledWith(
      'org-1',
      expect.objectContaining({ offset: 50 }),
      undefined,
    );
    // Never routed through the mixed-inbox query — that is what limited a tab
    // to the pages the inbox had loaded.
    expect(mockFindPaginated).not.toHaveBeenCalled();
  });

  it('forwards the free-text search term to the tab query', async () => {
    (validateQuery as unknown as jest.Mock).mockReturnValueOnce({ ok: true, value: { search: 'outage' } });
    mockFindAnnouncements.mockResolvedValue({ data: [], total: 0, limit: 25, offset: 0, hasMore: false });

    await announcements(mockReq(), mockRes());

    expect(mockFindAnnouncements).toHaveBeenCalledWith('org-1', expect.any(Object), 'outage');
  });

  it('rejects an invalid query with a 400 instead of silently ignoring it', async () => {
    (validateQuery as unknown as jest.Mock).mockReturnValueOnce({ ok: false, error: 'search must be <= 200 chars' });

    const res = mockRes();
    await conversations(mockReq(), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockFindConversations).not.toHaveBeenCalled();
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
