// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Handler tests for routes/delete-message (DELETE /:id), including the
 * message.delete audit emission.
 *
 * The non-admin ownership pre-check uses the org-scoped `findById`; the
 * viewer-scoped `findVisibleById` is wired to throw so the suite proves which
 * lookup the route depends on.
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

const mockFindById = jest.fn<AnyFn>();
const mockDelete = jest.fn<AnyFn>();
const mockDeleteThread = jest.fn<AnyFn>();
const mockDeleteAsSysadmin = jest.fn<AnyFn>();

jest.unstable_mockModule('../src/services/message-service.js', () => ({
  messageService: {
    findById: mockFindById,
    findVisibleById: forbiddenLookup('findVisibleById'),
    delete: mockDelete,
    deleteThread: mockDeleteThread,
    deleteAsSysadmin: mockDeleteAsSysadmin,
  },
}));

// Remote-audit spy: route handlers emit attributed `message.*` events via
// api-core `recordAudit`, overridden in the api-core mock so tests can assert on the emitted
// event and that NO message body reaches the trail.
const mockAuditRecord = jest.fn<AnyFn>();

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({ ...routeApiCoreOverrides(), recordAudit: mockAuditRecord }));
jest.unstable_mockModule('@pipeline-builder/api-server', () => routeApiServerMock());
jest.unstable_mockModule('@pipeline-builder/pipeline-data', () => stubModule('@pipeline-builder/pipeline-data', {
  schema: { message: { $inferInsert: {} } },
}));

const { sendBadRequest, sendError, isSystemAdmin, sendEntityNotFound } = await import('@pipeline-builder/api-core');
const { createDeleteMessageRoutes } = await import('../src/routes/delete-message.js');

const mockSseManager = createMockSseManager();
const deleteRouter = createDeleteMessageRoutes(mockSseManager);

describe('DELETE /messages/:id', () => {
  const handler = getHandler(deleteRouter, 'delete', '/:id');

  beforeEach(() => { jest.clearAllMocks(); });

  it('allows system admin to delete any message', async () => {
    (isSystemAdmin as jest.Mock<AnyFn>).mockReturnValue(true);
    mockDeleteAsSysadmin.mockResolvedValue({ id: 'msg-1', threadId: null, orgId: 'org-1', recipientOrgId: '000000000000000000000001' });
    mockDeleteThread.mockResolvedValue(undefined);

    const req = mockReq({ params: { id: 'msg-1' } });
    const res = mockRes();
    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    // Sysadmin moderation drops the org pin (id + userId only) — see deleteAsSysadmin.
    expect(mockDeleteAsSysadmin).toHaveBeenCalledWith('msg-1', 'user-1');
    // Verify SSE notification sent to the other party
    expect(mockSseManager.send).toHaveBeenCalledWith(
      '000000000000000000000001',
      'MESSAGE',
      'Message deleted',
      expect.objectContaining({ action: 'MESSAGE_DELETED', messageId: 'msg-1' }),
    );
  });

  it('allows message sender to self-delete', async () => {
    (isSystemAdmin as jest.Mock<AnyFn>).mockReturnValue(false);
    mockFindById.mockResolvedValue({ id: 'msg-1', createdBy: 'user-1' });
    mockDelete.mockResolvedValue({ id: 'msg-1', threadId: null, orgId: 'org-1', recipientOrgId: '000000000000000000000001' });
    mockDeleteThread.mockResolvedValue(undefined);

    const req = mockReq({ params: { id: 'msg-1' } });
    const res = mockRes();
    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    // Ownership pre-check uses the org-scoped findById (the viewer-scoped read
    // would hide a per-user message from its own sender's org-mates' checks).
    expect(mockFindById).toHaveBeenCalledWith('msg-1', 'org-1');
    // Verify SSE notification sent to the other party
    expect(mockSseManager.send).toHaveBeenCalledWith(
      '000000000000000000000001',
      'MESSAGE',
      'Message deleted',
      expect.objectContaining({ action: 'MESSAGE_DELETED', messageId: 'msg-1' }),
    );
  });

  it('returns 403 when non-admin non-sender tries to delete', async () => {
    (isSystemAdmin as jest.Mock<AnyFn>).mockReturnValue(false);
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
    (isSystemAdmin as jest.Mock<AnyFn>).mockReturnValue(false);
    mockFindById.mockResolvedValue(null);

    const req = mockReq({ params: { id: 'nonexistent' } });
    const res = mockRes();
    await handler(req, res);

    expect(sendEntityNotFound).toHaveBeenCalledWith(res, 'Message');
  });

  it('returns 404 when delete returns null (admin)', async () => {
    (isSystemAdmin as jest.Mock<AnyFn>).mockReturnValue(true);
    mockDeleteAsSysadmin.mockResolvedValue(null);

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
    (isSystemAdmin as jest.Mock<AnyFn>).mockReturnValue(true);
    mockDeleteAsSysadmin.mockRejectedValue(new Error('DB error'));

    const req = mockReq({ params: { id: 'msg-1' } });
    const res = mockRes();
    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
  });

  it('does not send SSE notification for broadcast message deletion', async () => {
    (isSystemAdmin as jest.Mock<AnyFn>).mockReturnValue(true);
    mockDeleteAsSysadmin.mockResolvedValue({ id: 'msg-1', threadId: null, orgId: '000000000000000000000001', recipientOrgId: '*' });
    mockDeleteThread.mockResolvedValue(undefined);

    const req = mockReq({ params: { id: 'msg-1' } });
    const res = mockRes();
    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(mockSseManager.send).not.toHaveBeenCalled();
  });
});

// Remote audit emissions

describe('Remote audit emissions (delete)', () => {
  const deleteHandler = getHandler(deleteRouter, 'delete', '/:id');

  beforeEach(() => { jest.clearAllMocks(); });

  it('emits message.delete with metadata (no body) on successful delete', async () => {
    (isSystemAdmin as jest.Mock<AnyFn>).mockReturnValue(true);
    mockDeleteAsSysadmin.mockResolvedValue({
      id: 'msg-1',
      threadId: null,
      orgId: 'org-1',
      recipientOrgId: '000000000000000000000001',
      messageType: 'announcement',
    });
    mockDeleteThread.mockResolvedValue(undefined);

    const req = mockReq({ user: { sub: 'admin-9' }, params: { id: 'msg-1' } });
    const res = mockRes();
    await deleteHandler(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(mockAuditRecord).toHaveBeenCalledTimes(1);
    expect(mockAuditRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'message.delete',
        actorId: 'admin-9',
        orgId: 'org-1',
        affectedOrgId: 'org-1', // deleted.orgId
        targetType: 'message',
        targetId: 'msg-1',
        details: expect.objectContaining({ isAnnouncement: true }),
      }),
    );

    const [event] = mockAuditRecord.mock.calls[0] as [any];
    expect(event.details).not.toHaveProperty('content');
  });

  it('records the owning org as affectedOrgId on a cross-org sysadmin delete', async () => {
    (isSystemAdmin as jest.Mock<AnyFn>).mockReturnValue(true);
    mockDeleteAsSysadmin.mockResolvedValue({
      id: 'msg-2',
      threadId: null,
      orgId: 'tenant-7',
      recipientOrgId: '000000000000000000000001',
      messageType: 'conversation',
    });
    mockDeleteThread.mockResolvedValue(undefined);

    const req = mockReq({ user: { sub: 'admin-9' }, params: { id: 'msg-2' } });
    const res = mockRes();
    await deleteHandler(req, res);

    expect(mockAuditRecord).toHaveBeenCalledWith(expect.objectContaining({
      action: 'message.delete',
      orgId: 'org-1',
      affectedOrgId: 'tenant-7',
      targetType: 'message',
      targetId: 'msg-2',
    }));
  });
});
