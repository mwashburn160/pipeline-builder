/**
 * Tests for message route handlers.
 *
 * Extracts route handlers from routers and tests them directly
 * with mock req/res objects — no HTTP server needed.
 */

// Mocks — must be defined before imports

const mockFindPaginated = jest.fn();
const mockFindAnnouncements = jest.fn();
const mockFindConversations = jest.fn();
const mockGetUnreadCount = jest.fn();
const mockFindById = jest.fn();
const mockFindThreadMessages = jest.fn();
const mockCreate = jest.fn();
const mockMarkAsRead = jest.fn();
const mockMarkThreadAsRead = jest.fn();
const mockDelete = jest.fn();
const mockDeleteThread = jest.fn();

jest.mock('../src/services/message-service', () => ({
  messageService: {
    findPaginated: mockFindPaginated,
    findAnnouncements: mockFindAnnouncements,
    findConversations: mockFindConversations,
    getUnreadCount: mockGetUnreadCount,
    findById: mockFindById,
    findThreadMessages: mockFindThreadMessages,
    create: mockCreate,
    markAsRead: mockMarkAsRead,
    markThreadAsRead: mockMarkThreadAsRead,
    delete: mockDelete,
    deleteThread: mockDeleteThread,
  },
}));

jest.mock('../src/helpers/message-helpers', () => ({
  sendMessageNotFound: jest.fn((res: any) => {
    res.status(404).json({ success: false, statusCode: 404, message: 'Message not found.' });
  }),
  sendThreadNotFound: jest.fn((res: any) => {
    res.status(404).json({ success: false, statusCode: 404, message: 'Thread not found.' });
  }),
}));

jest.mock('@mwashburn160/api-core', () => ({
  AccessModifier: { PUBLIC: 'public', PRIVATE: 'private' },
  getParam: jest.fn((params: Record<string, string>, key: string) => params[key]),
  ErrorCode: {
    MISSING_REQUIRED_FIELD: 'MISSING_REQUIRED_FIELD',
    VALIDATION_ERROR: 'VALIDATION_ERROR',
    INSUFFICIENT_PERMISSIONS: 'INSUFFICIENT_PERMISSIONS',
    INTERNAL_ERROR: 'INTERNAL_ERROR',
  },
  isSystemAdmin: jest.fn(() => false),
  errorMessage: jest.fn((e: unknown) => (e instanceof Error ? e.message : String(e))),
  createLogger: jest.fn(() => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() })),
  sendSuccess: jest.fn((res: any, statusCode: number, data?: any, message?: string) => {
    const response: any = { success: true, statusCode };
    if (data !== undefined) response.data = data;
    if (message) response.message = message;
    res.status(statusCode).json(response);
  }),
  sendError: jest.fn((res: any, statusCode: number, msg: string, code?: string) => {
    res.status(statusCode).json({ success: false, statusCode, message: msg, code });
  }),
  sendBadRequest: jest.fn((res: any, msg: string, code?: string) => {
    res.status(400).json({ success: false, statusCode: 400, message: msg, code });
  }),
  sendInternalError: jest.fn((res: any, msg: string) => {
    res.status(500).json({ success: false, statusCode: 500, message: msg });
  }),
  parsePaginationParams: jest.fn(() => ({
    limit: 25,
    offset: 0,
    sortBy: 'createdAt',
    sortOrder: 'desc',
  })),
  validateBody: jest.fn((req: any) => {
    if (!req.body || Object.keys(req.body).length === 0) {
      return { ok: false, error: 'Request body is required' };
    }
    return { ok: true, value: req.body };
  }),
  MessageCreateSchema: {},
  MessageReplySchema: {},
  MessageFilterSchema: {},
  validateQuery: jest.fn(() => ({ ok: true, value: {} })),
  incrementQuota: jest.fn(),
  resolveRecipientAlias: jest.fn((recipientOrgId: string) => {
    const aliases = new Set(['support@pipeline-builder', 'help@pipeline-builder']);
    const normalized = recipientOrgId.trim().toLowerCase();
    if (aliases.has(normalized)) {
      return { resolvedOrgId: 'system', wasAlias: true, originalValue: recipientOrgId };
    }
    return { resolvedOrgId: normalized, wasAlias: false, originalValue: recipientOrgId };
  }),
}));

const mockGetContext = (req: any) => req.context;
const mockSendBadRequestForRoute = jest.fn((res: any, msg: string) => {
  res.status(400).json({ success: false, statusCode: 400, message: msg });
});
const mockSendInternalErrorForRoute = jest.fn((res: any, msg: string) => {
  res.status(500).json({ success: false, statusCode: 500, message: msg });
});

jest.mock('@mwashburn160/api-server', () => ({
  getContext: (req: any) => mockGetContext(req),
  withRoute: (handler: Function, options?: any) => async (req: any, res: any) => {
    const ctx = mockGetContext(req);
    const orgId = ctx.identity.orgId?.toLowerCase() || '';
    const userId = ctx.identity.userId || '';
    const requireOrgId = options?.requireOrgId !== false;
    if (requireOrgId && !orgId) {
      return mockSendBadRequestForRoute(res, 'Organization ID is required');
    }
    try {
      await handler({ req, res, ctx, orgId, userId });
    } catch (error: any) {
      const msg = error instanceof Error ? error.message : String(error);
      return mockSendInternalErrorForRoute(res, msg);
    }
  },
}));

jest.mock('@mwashburn160/pipeline-core', () => ({
  schema: { message: { $inferInsert: {} } },
}));

import { sendBadRequest, sendError, isSystemAdmin } from '@mwashburn160/api-core';
import { sendMessageNotFound, sendThreadNotFound } from '../src/helpers/message-helpers';
import { createCreateMessageRoutes } from '../src/routes/create-message';
import { createDeleteMessageRoutes } from '../src/routes/delete-message';
import { createReadMessageRoutes } from '../src/routes/read-messages';
import { createUpdateMessageRoutes } from '../src/routes/update-message';

// Helpers

const mockQuotaService = {
  increment: jest.fn().mockResolvedValue(undefined),
  check: jest.fn(),
  getUsage: jest.fn(),
} as any;

const mockSseManager = {
  send: jest.fn().mockReturnValue(1),
  broadcast: jest.fn().mockReturnValue(5),
  addClient: jest.fn(),
  hasClients: jest.fn(),
  getClientCount: jest.fn(),
  getStats: jest.fn(),
  closeRequest: jest.fn(),
  shutdown: jest.fn(),
  middleware: jest.fn(),
} as any;

const readRouter = createReadMessageRoutes(mockQuotaService);
const createRouter = createCreateMessageRoutes(mockSseManager);
const updateRouter = createUpdateMessageRoutes(mockSseManager);
const deleteRouter = createDeleteMessageRoutes(mockSseManager);

function getHandler(router: any, method: string, path: string) {
  const layer = router.stack.find(
    (l: any) => l.route?.path === path && l.route?.methods[method],
  );
  if (!layer) throw new Error(`No handler for ${method.toUpperCase()} ${path}`);
  return layer.route.stack[0].handle;
}

function mockReq(overrides: Record<string, unknown> = {}): any {
  return {
    params: {},
    query: {},
    body: {},
    headers: { authorization: 'Bearer tok' },
    context: {
      identity: { orgId: 'ORG-1', userId: 'user-1' },
      log: jest.fn(),
      requestId: 'req-1',
    },
    ...overrides,
  };
}

function mockRes(): any {
  const res: any = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

// Read Routes

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
        success: true,
        data: expect.objectContaining({
          messages: expect.arrayContaining([expect.objectContaining({ id: '1' })]),
          pagination: { total: 1, limit: 25, offset: 0, hasMore: false },
        }),
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

  it('returns announcements', async () => {
    const announcements = [{ id: '1', subject: 'System update', messageType: 'announcement' }];
    mockFindAnnouncements.mockResolvedValue(announcements);

    const req = mockReq();
    const res = mockRes();
    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        data: expect.objectContaining({ messages: announcements }),
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

  it('returns conversations', async () => {
    const conversations = [{ id: '1', subject: 'Question', messageType: 'conversation' }];
    mockFindConversations.mockResolvedValue(conversations);

    const req = mockReq();
    const res = mockRes();
    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        data: expect.objectContaining({ messages: conversations }),
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
    mockFindById.mockResolvedValue(message);

    const req = mockReq({ params: { id: 'msg-1' } });
    const res = mockRes();
    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        data: expect.objectContaining({ message }),
      }),
    );
  });

  it('returns 404 when message not found', async () => {
    mockFindById.mockResolvedValue(null);

    const req = mockReq({ params: { id: 'nonexistent' } });
    const res = mockRes();
    await handler(req, res);

    expect(sendMessageNotFound).toHaveBeenCalledWith(res);
  });

  it('returns 400 when ID param is missing', async () => {
    const req = mockReq({ params: {} });
    const res = mockRes();
    await handler(req, res);

    expect(sendBadRequest).toHaveBeenCalledWith(res, 'Message ID is required', 'MISSING_REQUIRED_FIELD');
  });

  it('returns 500 on service error', async () => {
    mockFindById.mockRejectedValue(new Error('DB error'));

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
    mockFindById.mockResolvedValue(root);
    mockFindThreadMessages.mockResolvedValue([reply]);

    const req = mockReq({ params: { id: 'msg-1' } });
    const res = mockRes();
    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        data: expect.objectContaining({
          messages: [root, reply],
        }),
      }),
    );
  });

  it('returns 404 when root message not found', async () => {
    mockFindById.mockResolvedValue(null);

    const req = mockReq({ params: { id: 'nonexistent' } });
    const res = mockRes();
    await handler(req, res);

    expect(sendThreadNotFound).toHaveBeenCalledWith(res);
  });

  it('returns 400 when ID param is missing', async () => {
    const req = mockReq({ params: {} });
    const res = mockRes();
    await handler(req, res);

    expect(sendBadRequest).toHaveBeenCalledWith(res, 'Message ID is required', 'MISSING_REQUIRED_FIELD');
  });
});

// Create Routes

describe('POST /messages (create)', () => {
  const handler = getHandler(createRouter, 'post', '/');

  beforeEach(() => jest.clearAllMocks());

  it('creates a message and returns 201', async () => {
    const created = { id: 'msg-new', subject: 'New message' };
    mockCreate.mockResolvedValue(created);

    const req = mockReq({
      body: {
        recipientOrgId: 'system',
        messageType: 'conversation',
        subject: 'New message',
        content: 'Hello system',
        priority: 'normal',
      },
    });
    const res = mockRes();
    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(201);
    expect(mockCreate).toHaveBeenCalled();
    // Verify SSE notification was sent to recipient org
    expect(mockSseManager.send).toHaveBeenCalledWith(
      'system',
      'MESSAGE',
      'New message',
      expect.objectContaining({ action: 'NEW_MESSAGE', messageId: 'msg-new' }),
    );
  });

  it('returns 400 on invalid body', async () => {
    const req = mockReq({ body: {} });
    const res = mockRes();
    await handler(req, res);

    expect(sendBadRequest).toHaveBeenCalledWith(res, 'Request body is required', 'VALIDATION_ERROR');
  });

  it('returns 403 when non-system org creates announcement', async () => {
    const req = mockReq({
      body: {
        recipientOrgId: '*',
        messageType: 'announcement',
        subject: 'Update',
        content: 'Content',
        priority: 'normal',
      },
    });
    const res = mockRes();
    await handler(req, res);

    expect(sendError).toHaveBeenCalledWith(
      res,
      403,
      'Only system org can create announcements',
      'INSUFFICIENT_PERMISSIONS',
    );
  });

  it('allows system org to create announcements', async () => {
    mockCreate.mockResolvedValue({ id: 'msg-ann', subject: 'Update' });

    const req = mockReq({
      body: {
        recipientOrgId: '*',
        messageType: 'announcement',
        subject: 'Update',
        content: 'System-wide update',
        priority: 'normal',
      },
      context: {
        identity: { orgId: 'system', userId: 'admin' },
        log: jest.fn(),
        requestId: 'req-1',
      },
    });
    const res = mockRes();
    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(201);
    // Verify SSE broadcast was used for announcements
    expect(mockSseManager.broadcast).toHaveBeenCalledWith(
      'MESSAGE',
      'New announcement',
      expect.objectContaining({ action: 'NEW_MESSAGE', messageId: 'msg-ann' }),
    );
  });

  it('returns 403 when non-system org messages non-system org', async () => {
    const req = mockReq({
      body: {
        recipientOrgId: 'other-org',
        messageType: 'conversation',
        subject: 'Hello',
        content: 'Content',
        priority: 'normal',
      },
    });
    const res = mockRes();
    await handler(req, res);

    expect(sendError).toHaveBeenCalledWith(
      res,
      403,
      'Organizations can only start conversations with the system org',
      'INSUFFICIENT_PERMISSIONS',
    );
  });

  it('returns 500 on service error', async () => {
    mockCreate.mockRejectedValue(new Error('DB error'));

    const req = mockReq({
      body: {
        recipientOrgId: 'system',
        messageType: 'conversation',
        subject: 'Test',
        content: 'Content',
        priority: 'normal',
      },
    });
    const res = mockRes();
    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
  });

  it('resolves support alias to system org and creates message', async () => {
    mockCreate.mockResolvedValue({ id: 'msg-alias', subject: 'Help request' });

    const req = mockReq({
      body: {
        recipientOrgId: 'support@pipeline-builder',
        messageType: 'conversation',
        subject: 'Help request',
        content: 'Need help with pipeline',
        priority: 'normal',
      },
    });
    const res = mockRes();
    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(201);
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ recipientOrgId: 'system' }),
      'user-1',
    );
    expect(mockSseManager.send).toHaveBeenCalledWith(
      'system',
      'MESSAGE',
      'New message',
      expect.objectContaining({ action: 'NEW_MESSAGE', messageId: 'msg-alias' }),
    );
  });

  it('resolves help alias to system org and creates message', async () => {
    mockCreate.mockResolvedValue({ id: 'msg-help', subject: 'Question' });

    const req = mockReq({
      body: {
        recipientOrgId: 'help@pipeline-builder',
        messageType: 'conversation',
        subject: 'Question',
        content: 'How do I configure stages?',
        priority: 'normal',
      },
    });
    const res = mockRes();
    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(201);
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ recipientOrgId: 'system' }),
      'user-1',
    );
  });

  it('does not resolve non-alias recipient org IDs', async () => {
    mockCreate.mockResolvedValue({ id: 'msg-direct', subject: 'Direct message' });

    const req = mockReq({
      body: {
        recipientOrgId: 'system',
        messageType: 'conversation',
        subject: 'Direct message',
        content: 'Directly addressed to system',
        priority: 'normal',
      },
    });
    const res = mockRes();
    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(201);
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ recipientOrgId: 'system' }),
      'user-1',
    );
  });
});

describe('POST /messages/:id/reply', () => {
  const handler = getHandler(createRouter, 'post', '/:id/reply');

  beforeEach(() => jest.clearAllMocks());

  it('creates a reply and returns 201', async () => {
    const rootMessage = {
      id: 'msg-1',
      orgId: 'org-1',
      recipientOrgId: 'system',
      messageType: 'conversation',
      subject: 'Original',
      priority: 'normal',
    };
    mockFindById.mockResolvedValue(rootMessage);
    mockCreate.mockResolvedValue({ id: 'msg-reply', threadId: 'msg-1' });

    const req = mockReq({
      params: { id: 'msg-1' },
      body: { content: 'Reply text' },
    });
    const res = mockRes();
    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(201);
    // Verify SSE notification sent to reply recipient
    expect(mockSseManager.send).toHaveBeenCalledWith(
      'system',
      'MESSAGE',
      'New reply',
      expect.objectContaining({ action: 'NEW_MESSAGE', messageId: 'msg-reply', threadId: 'msg-1' }),
    );
  });

  it('returns 404 when root message not found', async () => {
    mockFindById.mockResolvedValue(null);

    const req = mockReq({
      params: { id: 'nonexistent' },
      body: { content: 'Reply text' },
    });
    const res = mockRes();
    await handler(req, res);

    expect(sendMessageNotFound).toHaveBeenCalledWith(res);
  });

  it('returns 403 when user is not a participant', async () => {
    const rootMessage = {
      id: 'msg-1',
      orgId: 'other-org',
      recipientOrgId: 'another-org',
      messageType: 'conversation',
      subject: 'Private',
      priority: 'normal',
    };
    mockFindById.mockResolvedValue(rootMessage);

    const req = mockReq({
      params: { id: 'msg-1' },
      body: { content: 'Reply text' },
    });
    const res = mockRes();
    await handler(req, res);

    expect(sendError).toHaveBeenCalledWith(
      res,
      403,
      'You are not a participant in this conversation',
      'INSUFFICIENT_PERMISSIONS',
    );
  });

  it('returns 400 when ID param is missing', async () => {
    const req = mockReq({
      params: {},
      body: { content: 'Reply text' },
    });
    const res = mockRes();
    await handler(req, res);

    expect(sendBadRequest).toHaveBeenCalledWith(res, 'Message ID is required', 'MISSING_REQUIRED_FIELD');
  });
});

// Update Routes

describe('PUT /messages/:id/read', () => {
  const handler = getHandler(updateRouter, 'put', '/:id/read');

  beforeEach(() => jest.clearAllMocks());

  it('marks a message as read', async () => {
    const message = { id: 'msg-1', isRead: true };
    mockMarkAsRead.mockResolvedValue(message);
    mockGetUnreadCount.mockResolvedValue(3);

    const req = mockReq({ params: { id: 'msg-1' } });
    const res = mockRes();
    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(mockMarkAsRead).toHaveBeenCalledWith('msg-1', 'org-1', 'user-1');
    // Verify SSE unread count push
    expect(mockSseManager.send).toHaveBeenCalledWith(
      'org-1',
      'MESSAGE',
      'Unread count updated',
      expect.objectContaining({ action: 'UNREAD_COUNT', unreadCount: 3 }),
    );
  });

  it('returns 404 when message not found', async () => {
    mockMarkAsRead.mockResolvedValue(null);

    const req = mockReq({ params: { id: 'nonexistent' } });
    const res = mockRes();
    await handler(req, res);

    expect(sendMessageNotFound).toHaveBeenCalledWith(res);
  });

  it('returns 400 when ID param is missing', async () => {
    const req = mockReq({ params: {} });
    const res = mockRes();
    await handler(req, res);

    expect(sendBadRequest).toHaveBeenCalledWith(res, 'Message ID is required', 'MISSING_REQUIRED_FIELD');
  });

  it('returns 500 on service error', async () => {
    mockMarkAsRead.mockRejectedValue(new Error('DB error'));

    const req = mockReq({ params: { id: 'msg-1' } });
    const res = mockRes();
    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
  });
});

describe('PUT /messages/:id/thread/read', () => {
  const handler = getHandler(updateRouter, 'put', '/:id/thread/read');

  beforeEach(() => jest.clearAllMocks());

  it('marks entire thread as read', async () => {
    mockMarkAsRead.mockResolvedValue({ id: 'msg-1', isRead: true });
    mockMarkThreadAsRead.mockResolvedValue([{ id: 'msg-2' }, { id: 'msg-3' }]);
    mockGetUnreadCount.mockResolvedValue(0);

    const req = mockReq({ params: { id: 'msg-1' } });
    const res = mockRes();
    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        data: expect.objectContaining({ updated: 3 }),
      }),
    );
    // Verify SSE unread count push
    expect(mockSseManager.send).toHaveBeenCalledWith(
      'org-1',
      'MESSAGE',
      'Unread count updated',
      expect.objectContaining({ action: 'UNREAD_COUNT', unreadCount: 0 }),
    );
  });

  it('returns 400 when ID param is missing', async () => {
    const req = mockReq({ params: {} });
    const res = mockRes();
    await handler(req, res);

    expect(sendBadRequest).toHaveBeenCalledWith(res, 'Message ID is required', 'MISSING_REQUIRED_FIELD');
  });

  it('returns 500 on service error', async () => {
    mockMarkAsRead.mockRejectedValue(new Error('DB error'));

    const req = mockReq({ params: { id: 'msg-1' } });
    const res = mockRes();
    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
  });
});

// Delete Routes

describe('DELETE /messages/:id', () => {
  const handler = getHandler(deleteRouter, 'delete', '/:id');

  beforeEach(() => jest.clearAllMocks());

  it('allows system admin to delete any message', async () => {
    (isSystemAdmin as jest.Mock).mockReturnValue(true);
    mockDelete.mockResolvedValue({ id: 'msg-1', threadId: null, orgId: 'org-1', recipientOrgId: 'system' });
    mockDeleteThread.mockResolvedValue(undefined);

    const req = mockReq({ params: { id: 'msg-1' } });
    const res = mockRes();
    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(mockDelete).toHaveBeenCalledWith('msg-1', 'org-1', 'user-1');
    // Verify SSE notification sent to the other party
    expect(mockSseManager.send).toHaveBeenCalledWith(
      'system',
      'MESSAGE',
      'Message deleted',
      expect.objectContaining({ action: 'MESSAGE_DELETED', messageId: 'msg-1' }),
    );
  });

  it('allows message sender to self-delete', async () => {
    (isSystemAdmin as jest.Mock).mockReturnValue(false);
    mockFindById.mockResolvedValue({ id: 'msg-1', createdBy: 'user-1' });
    mockDelete.mockResolvedValue({ id: 'msg-1', threadId: null, orgId: 'org-1', recipientOrgId: 'system' });
    mockDeleteThread.mockResolvedValue(undefined);

    const req = mockReq({ params: { id: 'msg-1' } });
    const res = mockRes();
    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    // Verify SSE notification sent to the other party
    expect(mockSseManager.send).toHaveBeenCalledWith(
      'system',
      'MESSAGE',
      'Message deleted',
      expect.objectContaining({ action: 'MESSAGE_DELETED', messageId: 'msg-1' }),
    );
  });

  it('returns 403 when non-admin non-sender tries to delete', async () => {
    (isSystemAdmin as jest.Mock).mockReturnValue(false);
    mockFindById.mockResolvedValue({ id: 'msg-1', createdBy: 'other-user' });

    const req = mockReq({ params: { id: 'msg-1' } });
    const res = mockRes();
    await handler(req, res);

    expect(sendError).toHaveBeenCalledWith(
      res,
      403,
      'Only admins or the message sender can delete messages',
      'INSUFFICIENT_PERMISSIONS',
    );
  });

  it('returns 404 when message not found (non-admin)', async () => {
    (isSystemAdmin as jest.Mock).mockReturnValue(false);
    mockFindById.mockResolvedValue(null);

    const req = mockReq({ params: { id: 'nonexistent' } });
    const res = mockRes();
    await handler(req, res);

    expect(sendMessageNotFound).toHaveBeenCalledWith(res);
  });

  it('returns 404 when delete returns null (admin)', async () => {
    (isSystemAdmin as jest.Mock).mockReturnValue(true);
    mockDelete.mockResolvedValue(null);

    const req = mockReq({ params: { id: 'nonexistent' } });
    const res = mockRes();
    await handler(req, res);

    expect(sendMessageNotFound).toHaveBeenCalledWith(res);
  });

  it('returns 400 when ID param is missing', async () => {
    const req = mockReq({ params: {} });
    const res = mockRes();
    await handler(req, res);

    expect(sendBadRequest).toHaveBeenCalledWith(res, 'Message ID is required', 'MISSING_REQUIRED_FIELD');
  });

  it('returns 500 on service error', async () => {
    (isSystemAdmin as jest.Mock).mockReturnValue(true);
    mockDelete.mockRejectedValue(new Error('DB error'));

    const req = mockReq({ params: { id: 'msg-1' } });
    const res = mockRes();
    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
  });

  it('does not send SSE notification for broadcast message deletion', async () => {
    (isSystemAdmin as jest.Mock).mockReturnValue(true);
    mockDelete.mockResolvedValue({ id: 'msg-1', threadId: null, orgId: 'system', recipientOrgId: '*' });
    mockDeleteThread.mockResolvedValue(undefined);

    const req = mockReq({ params: { id: 'msg-1' } });
    const res = mockRes();
    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(mockSseManager.send).not.toHaveBeenCalled();
  });
});

// SSE Notification Resilience

describe('SSE notification resilience', () => {
  beforeEach(() => jest.clearAllMocks());

  it('does not fail HTTP response if SSE send throws on message create', async () => {
    mockSseManager.send.mockImplementation(() => { throw new Error('SSE failure'); });
    mockCreate.mockResolvedValue({ id: 'msg-1', subject: 'Test' });

    const handler = getHandler(createRouter, 'post', '/');
    const req = mockReq({
      body: {
        recipientOrgId: 'system',
        messageType: 'conversation',
        subject: 'Test',
        content: 'Content',
        priority: 'normal',
      },
    });
    const res = mockRes();
    await handler(req, res);

    // HTTP response should still succeed despite SSE failure
    expect(res.status).toHaveBeenCalledWith(201);
  });

  it('does not fail HTTP response if SSE send throws on mark as read', async () => {
    mockSseManager.send.mockImplementation(() => { throw new Error('SSE failure'); });
    mockMarkAsRead.mockResolvedValue({ id: 'msg-1', isRead: true });
    mockGetUnreadCount.mockResolvedValue(0);

    const handler = getHandler(updateRouter, 'put', '/:id/read');
    const req = mockReq({ params: { id: 'msg-1' } });
    const res = mockRes();
    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('does not fail HTTP response if SSE broadcast throws on announcement', async () => {
    mockSseManager.broadcast.mockImplementation(() => { throw new Error('SSE failure'); });
    mockCreate.mockResolvedValue({ id: 'msg-ann', subject: 'Update' });

    const handler = getHandler(createRouter, 'post', '/');
    const req = mockReq({
      body: {
        recipientOrgId: '*',
        messageType: 'announcement',
        subject: 'Update',
        content: 'System update',
        priority: 'normal',
      },
      context: {
        identity: { orgId: 'system', userId: 'admin' },
        log: jest.fn(),
        requestId: 'req-1',
      },
    });
    const res = mockRes();
    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(201);
  });
});
