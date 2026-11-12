// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Handler tests for routes/update-message (PATCH /:id edit, PUT /:id/read,
 * PUT /:id/thread/read), including SSE-failure resilience.
 */

import type { AnyFn } from '@pipeline-builder/api-core/testing';
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { stubModule } from '@pipeline-builder/api-core/testing';
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

const mockMarkAsRead = jest.fn<AnyFn>();
const mockEditContent = jest.fn<AnyFn>();
const mockMarkThreadAsRead = jest.fn<AnyFn>();
const mockGetUnreadCount = jest.fn<AnyFn>();
const mockHideFromInbox = jest.fn<AnyFn>();

jest.unstable_mockModule('../src/services/message-service.js', () => ({
  messageService: {
    markAsRead: mockMarkAsRead,
    editContent: mockEditContent,
    markThreadAsRead: mockMarkThreadAsRead,
    getUnreadCount: mockGetUnreadCount,
    hideFromInbox: mockHideFromInbox,
    // Writes are scoped inside the service predicates — no pre-read lookups.
    findById: forbiddenLookup('findById'),
    findVisibleById: forbiddenLookup('findVisibleById'),
  },
}));

// api-core `recordAudit`, overridden so the edit's audit row can be asserted on.
const mockAuditRecord = jest.fn<AnyFn>();
jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({ ...routeApiCoreOverrides(), recordAudit: mockAuditRecord }));
jest.unstable_mockModule('@pipeline-builder/api-server', () => routeApiServerMock());
jest.unstable_mockModule('@pipeline-builder/pipeline-data', () => stubModule('@pipeline-builder/pipeline-data', {
  schema: { message: { $inferInsert: {} } },
}));

const { sendBadRequest, sendEntityNotFound } = await import('@pipeline-builder/api-core');
const { createUpdateMessageRoutes } = await import('../src/routes/update-message.js');

const mockSseManager = createMockSseManager();
const updateRouter = createUpdateMessageRoutes(mockSseManager);

describe('PATCH /messages/:id (edit content)', () => {
  const handler = getHandler(updateRouter, 'patch', '/:id');

  beforeEach(() => { jest.clearAllMocks(); });

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

    // Audited with SAFE METADATA ONLY — the body's length, never the body.
    expect(mockAuditRecord).toHaveBeenCalledWith(expect.objectContaining({
      action: 'message.update',
      actorId: 'user-1',
      orgId: 'org-1',
      targetType: 'message',
      targetId: 'msg-1',
      details: expect.objectContaining({ threadId: 'msg-1', contentLength: 'fixed text'.length }),
    }));
    expect(JSON.stringify(mockAuditRecord.mock.calls[0]![0])).not.toContain('fixed text');
  });

  it('404s when the caller is not the author / message not found', async () => {
    mockEditContent.mockResolvedValue(null);
    const req = mockReq({ params: { id: 'msg-x' }, body: { content: 'nope' } });
    const res = mockRes();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(404);
    // The refused attempt is still on the trail, as a failure.
    expect(mockAuditRecord).toHaveBeenCalledWith(expect.objectContaining({
      action: 'message.update', targetId: 'msg-x', outcome: 'failure',
    }));
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

  beforeEach(() => { jest.clearAllMocks(); });

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
      'Unread count changed',
      // Signal only: the count is viewer-scoped but the channel is org-scoped,
      // so a number here would overwrite every other member's badge with the
      // reader's. Each client refetches its own.
      { action: 'UNREAD_COUNT' },
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

  beforeEach(() => { jest.clearAllMocks(); });

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
      'Unread count changed',
      // Signal only: the count is viewer-scoped but the channel is org-scoped,
      // so a number here would overwrite every other member's badge with the
      // reader's. Each client refetches its own.
      { action: 'UNREAD_COUNT' },
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
  beforeEach(() => { jest.clearAllMocks(); });

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

describe('POST /messages/hide — remove from this org\'s inbox', () => {
  const handler = getHandler(updateRouter, 'post', '/hide');

  beforeEach(() => { jest.clearAllMocks(); });

  it('forwards the ACTIVE filters and the tab, and reports what changed', async () => {
    mockHideFromInbox.mockResolvedValue(7);
    mockGetUnreadCount.mockResolvedValue(0);

    const req = mockReq({ body: { messageType: 'conversation', isRead: true, priority: 'normal', channel: 'support', search: 'invoice' } });
    const res = mockRes();
    await handler(req, res);

    // The tab goes through as its own argument; the rest as list filters — the
    // same shape the inbox query uses, so "remove what I'm looking at" cannot
    // quietly widen by dropping one.
    expect(mockHideFromInbox).toHaveBeenCalledWith(
      'conversation', 'org-1', expect.any(String),
      { isRead: true, priority: 'normal', channel: 'support', search: 'invoice' },
    );
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: true, data: expect.objectContaining({ hidden: 7 }) }),
    );
  });

  it('forwards an explicit checkbox selection and the sender filter', async () => {
    mockHideFromInbox.mockResolvedValue(2);
    mockGetUnreadCount.mockResolvedValue(0);

    const ids = ['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002'];
    const req = mockReq({ body: { ids, sentBy: 'others' } });
    const res = mockRes();
    await handler(req, res);

    expect(mockHideFromInbox).toHaveBeenCalledWith(undefined, 'org-1', expect.any(String), { ids, sentBy: 'others' });
    // The trail records HOW MANY were named, never which.
    const row = mockAuditRecord.mock.calls[0][0] as { details: Record<string, unknown> };
    expect(row.details).toMatchObject({ count: 2, selected: 2, sentBy: 'others' });
    expect(JSON.stringify(row.details)).not.toContain(ids[0]);
  });

  it('audits ONCE with the count and scope, and never the search TEXT', async () => {
    mockHideFromInbox.mockResolvedValue(400);
    mockGetUnreadCount.mockResolvedValue(0);

    const req = mockReq({ body: { isRead: true, search: 'quarterly revenue' } });
    const res = mockRes();
    await handler(req, res);

    expect(mockAuditRecord).toHaveBeenCalledTimes(1);
    const row = mockAuditRecord.mock.calls[0][0] as { action: string; details: Record<string, unknown> };
    expect(row.action).toBe('message.hide');
    expect(row.details).toMatchObject({ count: 400, scope: 'all', isRead: true, searched: true });
    // The query can carry anything the user typed; the trail records THAT there
    // was one, not what it said.
    expect(JSON.stringify(row.details)).not.toContain('quarterly revenue');
  });

  it('signals the unread badge, which a hidden unread message would otherwise strand', async () => {
    mockHideFromInbox.mockResolvedValue(3);
    mockGetUnreadCount.mockResolvedValue(0);

    const req = mockReq({ body: { isRead: false } });
    const res = mockRes();
    await handler(req, res);

    expect(mockSseManager.send).toHaveBeenCalledWith('org-1', 'MESSAGE', 'Unread count changed', { action: 'UNREAD_COUNT' });
  });
});
