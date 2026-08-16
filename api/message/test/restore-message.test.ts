// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for routes/restore-message.
 *
 * Extracts the POST /:id/restore handler from the router and tests it directly
 * with mock req/res objects — no HTTP server needed. Mirrors the sibling
 * delete-message coverage in routes.test.ts (same api-core / api-server /
 * message-service / audit mocking).
 *
 * Restore mirrors delete's authority: sysadmins moderate cross-org (no org pin,
 * `restore(id, '', userId)`); non-admins may restore only their OWN ROOT
 * message (`restore(id, orgId, userId)`).
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

// Mocks — must be defined before imports

const mockFindDeletedById = jest.fn<(...args: unknown[]) => unknown>();
const mockRestore = jest.fn<(...args: unknown[]) => unknown>();

jest.unstable_mockModule('../src/services/message-service.js', () => ({
  messageService: {
    findDeletedById: mockFindDeletedById,
    restore: mockRestore,
  },
}));

// Remote-audit spy: the restore handler emits an attributed `message.restore`
// event via getAuditClient().record with SAFE METADATA ONLY (never the body).
const mockAuditRecord = jest.fn();
jest.unstable_mockModule('../src/services/audit.js', () => ({
  getAuditClient: () => ({ record: mockAuditRecord }),
}));

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  getParam: jest.fn((params: Record<string, string>, key: string) => params[key]),
  isSystemAdmin: jest.fn(() => false),
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
  sendEntityNotFound: jest.fn((res: any, entity: string) => {
    res.status(404).json({ success: false, statusCode: 404, message: `${entity} not found.` });
  }),
}));

const mockSendBadRequestForRoute = jest.fn((res: any, msg: string) => {
  res.status(400).json({ success: false, statusCode: 400, message: msg });
});
const mockSendInternalErrorForRoute = jest.fn((res: any, msg: string) => {
  res.status(500).json({ success: false, statusCode: 500, message: msg });
});

jest.unstable_mockModule('@pipeline-builder/api-server', () => ({
  incCounter: () => undefined,
  getContext: (req: any) => req.context,
  withRoute: (handler: Function, options?: any) => async (req: any, res: any) => {
    const ctx = req.context;
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
  createProtectedRoute: jest.fn(() => []),
  createAuthenticatedWithOrgRoute: jest.fn(() => []),
}));

jest.unstable_mockModule('@pipeline-builder/pipeline-data', () => ({
  schema: { message: { $inferInsert: {} } },
}));

const { sendBadRequest, sendError, isSystemAdmin, sendEntityNotFound } = await import('@pipeline-builder/api-core');
const { createRestoreMessageRoutes } = await import('../src/routes/restore-message.js');

// Helpers

const router = createRestoreMessageRoutes();

function getHandler(method: string, path: string) {
  const layer = (router as any).stack.find(
    (l: any) => l.route?.path === path && l.route?.methods[method],
  );
  if (!layer) throw new Error(`No handler for ${method.toUpperCase()} ${path}`);
  const stack = layer.route.stack;
  return stack[stack.length - 1].handle;
}

function mockReq(overrides: Record<string, unknown> = {}): any {
  return {
    params: { id: 'msg-1' },
    query: {},
    body: {},
    headers: { authorization: 'Bearer tok' },
    user: { sub: 'user-1' },
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

// A soft-deleted ROOT message owned by user-1 in org-1.
const ownRootTombstone = {
  id: 'msg-1',
  orgId: 'org-1',
  createdBy: 'user-1',
  threadId: null,
  messageType: 'conversation',
};

// Tests

describe('POST /messages/:id/restore (restore)', () => {
  const handler = getHandler('post', '/:id/restore');

  beforeEach(() => jest.clearAllMocks());

  it('lets a non-admin restore their own root message (org-pinned) and returns 200', async () => {
    (isSystemAdmin as jest.Mock).mockReturnValue(false);
    mockFindDeletedById.mockResolvedValue(ownRootTombstone);
    mockRestore.mockResolvedValue(ownRootTombstone);

    const req = mockReq();
    const res = mockRes();
    await handler(req, res);

    // Non-admin load is org-scoped; restore stays pinned to the caller org.
    expect(mockFindDeletedById).toHaveBeenCalledWith('msg-1', 'org-1');
    expect(mockRestore).toHaveBeenCalledWith('msg-1', 'org-1', 'user-1');
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: true, statusCode: 200, message: 'Message restored successfully' }),
    );
  });

  it('emits an attributed message.restore audit event (metadata only, no body)', async () => {
    (isSystemAdmin as jest.Mock).mockReturnValue(false);
    mockFindDeletedById.mockResolvedValue(ownRootTombstone);
    mockRestore.mockResolvedValue({ ...ownRootTombstone, messageType: 'announcement' });

    const req = mockReq({ user: { sub: 'user-1' } });
    const res = mockRes();
    await handler(req, res);

    expect(mockAuditRecord).toHaveBeenCalledTimes(1);
    expect(mockAuditRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'message.restore',
        actorId: 'user-1',
        orgId: 'org-1',
        affectedOrgId: 'org-1', // restored.orgId
        targetType: 'message',
        targetId: 'msg-1',
        details: expect.objectContaining({ isAnnouncement: true }),
      }),
      'message',
    );

    // The message body must never reach the audit trail.
    const [event] = mockAuditRecord.mock.calls[0] as [any, string];
    expect(event.details).not.toHaveProperty('content');
  });

  it('lets a sysadmin restore cross-org, dropping the org pin', async () => {
    (isSystemAdmin as jest.Mock).mockReturnValue(true);
    const crossOrgTombstone = { id: 'msg-1', orgId: 'other-org', createdBy: 'someone-else', threadId: null, messageType: 'conversation' };
    mockFindDeletedById.mockResolvedValue(crossOrgTombstone);
    mockRestore.mockResolvedValue(crossOrgTombstone);

    const req = mockReq();
    const res = mockRes();
    await handler(req, res);

    // Sysadmin load spans orgs (no org pin) and restore drops the org pin ('').
    expect(mockFindDeletedById).toHaveBeenCalledWith('msg-1');
    expect(mockRestore).toHaveBeenCalledWith('msg-1', '', 'user-1');
    expect(res.status).toHaveBeenCalledWith(200);
    expect(mockAuditRecord).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'message.restore', affectedOrgId: 'other-org' }),
      'message',
    );
  });

  it('returns 403 when a non-admin tries to restore someone else\'s message', async () => {
    (isSystemAdmin as jest.Mock).mockReturnValue(false);
    mockFindDeletedById.mockResolvedValue({ ...ownRootTombstone, createdBy: 'other-user' });

    const req = mockReq();
    const res = mockRes();
    await handler(req, res);

    expect(sendError).toHaveBeenCalledWith(
      res,
      403,
      'Only admins or the message sender can restore messages',
      'INSUFFICIENT_PERMISSIONS',
    );
    expect(mockRestore).not.toHaveBeenCalled();
    expect(mockAuditRecord).not.toHaveBeenCalled();
  });

  it('returns 403 when a non-admin tries to restore a reply (non-root)', async () => {
    (isSystemAdmin as jest.Mock).mockReturnValue(false);
    mockFindDeletedById.mockResolvedValue({ ...ownRootTombstone, threadId: 'root-1' });

    const req = mockReq();
    const res = mockRes();
    await handler(req, res);

    expect(sendError).toHaveBeenCalledWith(
      res,
      403,
      'Only root messages can be restored by non-admins',
      'INSUFFICIENT_PERMISSIONS',
    );
    expect(mockRestore).not.toHaveBeenCalled();
    expect(mockAuditRecord).not.toHaveBeenCalled();
  });

  it('returns 404 when the tombstone does not exist (non-admin)', async () => {
    (isSystemAdmin as jest.Mock).mockReturnValue(false);
    mockFindDeletedById.mockResolvedValue(null);

    const req = mockReq({ params: { id: 'nonexistent' } });
    const res = mockRes();
    await handler(req, res);

    expect(sendEntityNotFound).toHaveBeenCalledWith(res, 'Message');
    expect(mockRestore).not.toHaveBeenCalled();
    expect(mockAuditRecord).not.toHaveBeenCalled();
  });

  it('returns 404 when restore returns null (matched no rows)', async () => {
    (isSystemAdmin as jest.Mock).mockReturnValue(false);
    mockFindDeletedById.mockResolvedValue(ownRootTombstone);
    mockRestore.mockResolvedValue(null);

    const req = mockReq();
    const res = mockRes();
    await handler(req, res);

    expect(mockRestore).toHaveBeenCalledWith('msg-1', 'org-1', 'user-1');
    expect(sendEntityNotFound).toHaveBeenCalledWith(res, 'Message');
    expect(mockAuditRecord).not.toHaveBeenCalled();
  });

  it('returns 400 when ID param is missing', async () => {
    const req = mockReq({ params: {} });
    const res = mockRes();
    await handler(req, res);

    expect(sendBadRequest).toHaveBeenCalledWith(res, 'Message ID is required', 'MISSING_REQUIRED_FIELD');
    expect(mockFindDeletedById).not.toHaveBeenCalled();
  });

  it('returns 500 on service error', async () => {
    (isSystemAdmin as jest.Mock).mockReturnValue(false);
    mockFindDeletedById.mockRejectedValue(new Error('DB error'));

    const req = mockReq();
    const res = mockRes();
    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(mockAuditRecord).not.toHaveBeenCalled();
  });
});
