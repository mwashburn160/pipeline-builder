// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Handler tests for routes/update-message (PATCH /:id edit, PUT /:id/read,
 * PUT /:id/thread/read), including SSE-failure resilience.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';
import {
  createMockSseManager,
  forbiddenLookup,
  getHandler,
  mockReq,
  mockRes,
  routeApiCoreOverrides,
  routeApiServerMock,
} from './helpers/route-test-utils.js';

const mockMarkAsRead = jest.fn<(...args: unknown[]) => unknown>();
const mockEditContent = jest.fn<(...args: unknown[]) => unknown>();
const mockMarkThreadAsRead = jest.fn<(...args: unknown[]) => unknown>();
const mockGetUnreadCount = jest.fn<(...args: unknown[]) => unknown>();

jest.unstable_mockModule('../src/services/message-service.js', () => ({
  messageService: {
    markAsRead: mockMarkAsRead,
    editContent: mockEditContent,
    markThreadAsRead: mockMarkThreadAsRead,
    getUnreadCount: mockGetUnreadCount,
    // Writes are scoped inside the service predicates — no pre-read lookups.
    findById: forbiddenLookup('findById'),
    findVisibleById: forbiddenLookup('findVisibleById'),
  },
}));

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock(routeApiCoreOverrides()));
jest.unstable_mockModule('@pipeline-builder/api-server', () => routeApiServerMock());
jest.unstable_mockModule('@pipeline-builder/pipeline-data', () => ({
  schema: { message: { $inferInsert: {} } },
}));

const { sendBadRequest, sendEntityNotFound } = await import('@pipeline-builder/api-core');
const { createUpdateMessageRoutes } = await import('../src/routes/update-message.js');

const mockSseManager = createMockSseManager();
const updateRouter = createUpdateMessageRoutes(mockSseManager);

describe('PATCH /messages/:id (edit content)', () => {
  const handler = getHandler(updateRouter, 'patch', '/:id');

  beforeEach(() => jest.clearAllMocks());

  it('edits a message and returns the updated row', async () => {
    const updated = { id: 'msg-1', orgId: 'org-1', recipientOrgId: '000000000000000000000001', threadId: null, content: 'fixed text', editedAt: '2026-08-16T00:00:00Z' };
    mockEditContent.mockResolvedValue(updated);

    const req = mockReq({ params: { id: 'msg-1' }, body: { content: 'fixed text' } });
    const res = mockRes();
    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    // Service is called with (id, callerOrg, callerUser, content) — authorship
    // is enforced inside the service predicate.
    expect(mockEditContent).toHaveBeenCalledWith('msg-1', 'org-1', 'user-1', 'fixed text');
  });

  it('404s when the caller is not the author / message not found', async () => {
    mockEditContent.mockResolvedValue(null);
    const req = mockReq({ params: { id: 'msg-x' }, body: { content: 'nope' } });
    const res = mockRes();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('400s on an empty body', async () => {
    const req = mockReq({ params: { id: 'msg-1' }, body: {} });
    const res = mockRes();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockEditContent).not.toHaveBeenCalled();
  });
});

describe('PUT /messages/:id/read', () => {
  const handler = getHandler(updateRouter, 'put', '/:id/read');

  beforeEach(() => jest.clearAllMocks());

  it('marks a message as read', async () => {
    const message = { id: 'msg-1', readBy: { 'org-1': '2026-04-27T00:00:00Z' } };
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

    expect(sendEntityNotFound).toHaveBeenCalledWith(res, 'Message');
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
    mockMarkAsRead.mockResolvedValue({ id: 'msg-1', readBy: { 'org-1': '2026-04-27T00:00:00Z' } });
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

// SSE Notification Resilience

describe('SSE notification resilience (update)', () => {
  beforeEach(() => jest.clearAllMocks());

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
});
