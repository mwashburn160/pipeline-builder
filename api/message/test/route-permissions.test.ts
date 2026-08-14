// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the RBAC gates on the message write / read-mutation routes.
 *
 * Closes a gate asymmetry: create/reply already require `messages:write`, but
 * DELETE /messages/:id was auth-only (an inline ownership check, no capability
 * gate) and PUT /:id/read + /:id/thread/read had no messaging permission floor.
 *
 * - DELETE /messages/:id       → requirePermission('messages:write') AND the
 *                                existing ownership check (both must hold)
 * - PUT /messages/:id/read     → requirePermission('messages:read')
 * - PUT /messages/:id/thread/read → requirePermission('messages:read')
 *
 * `requirePermission` is mocked with real semantics (checks the caller's
 * permission set) and the whole route stack is driven so the gate runs before
 * the handler, exactly as express would.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

const mockFindById = jest.fn<(...args: unknown[]) => unknown>();
const mockDelete = jest.fn<(...args: unknown[]) => unknown>();
const mockDeleteThread = jest.fn<(...args: unknown[]) => unknown>();
const mockMarkAsRead = jest.fn<(...args: unknown[]) => unknown>();
const mockMarkThreadAsRead = jest.fn<(...args: unknown[]) => unknown>();
const mockGetUnreadCount = jest.fn<(...args: unknown[]) => unknown>();
const mockFindPaginated = jest.fn<(...args: unknown[]) => unknown>();
const mockFindAnnouncements = jest.fn<(...args: unknown[]) => unknown>();
const mockFindConversations = jest.fn<(...args: unknown[]) => unknown>();
const mockFindThreadMessages = jest.fn<(...args: unknown[]) => unknown>();

jest.unstable_mockModule('../src/services/message-service.js', () => ({
  messageService: {
    findById: mockFindById,
    delete: mockDelete,
    deleteThread: mockDeleteThread,
    markAsRead: mockMarkAsRead,
    markThreadAsRead: mockMarkThreadAsRead,
    getUnreadCount: mockGetUnreadCount,
    findPaginated: mockFindPaginated,
    findAnnouncements: mockFindAnnouncements,
    findConversations: mockFindConversations,
    findThreadMessages: mockFindThreadMessages,
  },
}));

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  getParam: (params: Record<string, string>, key: string) => params[key],
  isSystemAdmin: () => false,
  sendSuccess: jest.fn((res: any, statusCode: number) => res.status(statusCode).json({ success: true, statusCode })),
  sendError: jest.fn((res: any, statusCode: number, msg: string, code?: string) =>
    res.status(statusCode).json({ success: false, statusCode, message: msg, code })),
  sendBadRequest: jest.fn((res: any, msg: string, code?: string) =>
    res.status(400).json({ success: false, statusCode: 400, message: msg, code })),
  sendEntityNotFound: jest.fn((res: any, entity: string) =>
    res.status(404).json({ success: false, statusCode: 404, message: `${entity} not found.` })),
  sendPaginatedNested: jest.fn((res: any, dataKey: string, data: any, opts: any) =>
    res.status(opts?.statusCode ?? 200).json({ [dataKey]: data })),
  parsePaginationParams: () => ({ limit: 25, offset: 0, sortBy: 'createdAt', sortOrder: 'desc' }),
  validateQuery: () => ({ ok: true, value: {} }),
  MessageFilterSchema: {},
  // Real gate semantics: 403 unless the caller holds the required permission.
  requirePermission: (perm: string) => (req: any, res: any, next: () => void) => {
    const perms: string[] = req.user?.permissions ?? [];
    if (perms.includes(perm)) return next();
    return res.status(403).json({ success: false, statusCode: 403, code: 'INSUFFICIENT_PERMISSIONS' });
  },
}));

jest.unstable_mockModule('@pipeline-builder/api-server', () => ({
  withRoute: (handler: Function) => async (req: any, res: any) => {
    await handler({ req, res, ctx: { log: jest.fn() }, orgId: req.__orgId, userId: req.__userId });
  },
  createAuthenticatedWithOrgRoute: jest.fn(() => []),
  // Read routes compose via `...createProtectedRoute(...)`; the auth/org/quota
  // middleware is exercised elsewhere — here we isolate the requirePermission
  // gate, so the chain is empty and `requirePermission('messages:read')` is the
  // only guard preceding the handler.
  createProtectedRoute: jest.fn(() => []),
  incrementQuotaFromCtx: jest.fn(),
}));

jest.unstable_mockModule('@pipeline-builder/pipeline-data', () => ({
  schema: { message: { $inferInsert: {} } },
}));

const { createDeleteMessageRoutes } = await import('../src/routes/delete-message.js');
const { createUpdateMessageRoutes } = await import('../src/routes/update-message.js');
const { createReadMessageRoutes } = await import('../src/routes/read-messages.js');

const sseManager = {
  send: jest.fn().mockReturnValue(1),
  broadcast: jest.fn().mockReturnValue(1),
} as any;

const quotaService = {
  increment: jest.fn<(...args: unknown[]) => unknown>().mockResolvedValue(undefined),
  check: jest.fn(),
  getUsage: jest.fn(),
} as any;

const deleteRouter = createDeleteMessageRoutes(sseManager);
const updateRouter = createUpdateMessageRoutes(sseManager);
const readRouter = createReadMessageRoutes(quotaService);

/** Drive the full middleware+handler stack for a route, like express would. */
async function runRoute(router: any, method: string, path: string, req: any, res: any) {
  const layer = router.stack.find(
    (l: any) => l.route?.path === path && l.route?.methods[method],
  );
  if (!layer) throw new Error(`no ${method.toUpperCase()} ${path}`);
  const stack = layer.route.stack as Array<{ handle: Function }>;
  let idx = 0;
  const next = async (): Promise<void> => {
    if (idx < stack.length) {
      const handle = stack[idx++].handle;
      await handle(req, res, next);
    }
  };
  await next();
}

function makeReq(overrides: Record<string, unknown> = {}): any {
  return {
    params: {},
    __orgId: 'org-1',
    __userId: 'user-1',
    user: { permissions: [] },
    ...overrides,
  };
}

function makeRes() {
  const json = jest.fn();
  const status = jest.fn().mockReturnValue({ json });
  return { res: { status, json } as any, status, json };
}

describe('DELETE /messages/:id — requires messages:write', () => {
  beforeEach(() => jest.clearAllMocks());

  it('403s a caller WITHOUT messages:write (ownership check never runs)', async () => {
    const { res, status, json } = makeRes();
    await runRoute(deleteRouter, 'delete', '/:id', makeReq({
      params: { id: 'msg-1' },
      user: { permissions: [] },
    }), res);

    expect(status).toHaveBeenCalledWith(403);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ code: 'INSUFFICIENT_PERMISSIONS' }));
    expect(mockFindById).not.toHaveBeenCalled();
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it('lets a WITH-messages:write owner delete their own root message (200)', async () => {
    mockFindById.mockResolvedValue({ id: 'msg-1', createdBy: 'user-1' });
    mockDelete.mockResolvedValue({ id: 'msg-1', threadId: null, orgId: 'org-1', recipientOrgId: '000000000000000000000001' });
    mockDeleteThread.mockResolvedValue(undefined);

    const { res, status } = makeRes();
    await runRoute(deleteRouter, 'delete', '/:id', makeReq({
      params: { id: 'msg-1' },
      user: { permissions: ['messages:write'] },
    }), res);

    expect(status).toHaveBeenCalledWith(200);
    expect(mockDelete).toHaveBeenCalledWith('msg-1', 'org-1', 'user-1');
  });

  it('still 403s a WITH-messages:write non-owner (ownership check also holds)', async () => {
    mockFindById.mockResolvedValue({ id: 'msg-1', createdBy: 'someone-else' });

    const { res, status, json } = makeRes();
    await runRoute(deleteRouter, 'delete', '/:id', makeReq({
      params: { id: 'msg-1' },
      user: { permissions: ['messages:write'] },
    }), res);

    expect(status).toHaveBeenCalledWith(403);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({
      message: 'Only admins or the message sender can delete messages',
    }));
    expect(mockDelete).not.toHaveBeenCalled();
  });
});

describe.each([
  ['/:id/read'],
  ['/:id/thread/read'],
])('PUT /messages%s — requires messages:read', (path) => {
  beforeEach(() => jest.clearAllMocks());

  it('403s a caller WITHOUT messages:read (service never runs)', async () => {
    const { res, status, json } = makeRes();
    await runRoute(updateRouter, 'put', path, makeReq({
      params: { id: 'msg-1' },
      user: { permissions: [] },
    }), res);

    expect(status).toHaveBeenCalledWith(403);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ code: 'INSUFFICIENT_PERMISSIONS' }));
    expect(mockMarkAsRead).not.toHaveBeenCalled();
  });

  it('lets a caller WITH messages:read mark as read (200)', async () => {
    mockMarkAsRead.mockResolvedValue({ id: 'msg-1' });
    mockMarkThreadAsRead.mockResolvedValue([]);
    mockGetUnreadCount.mockResolvedValue(0);

    const { res, status } = makeRes();
    await runRoute(updateRouter, 'put', path, makeReq({
      params: { id: 'msg-1' },
      user: { permissions: ['messages:read'] },
    }), res);

    expect(status).toHaveBeenCalledWith(200);
    expect(mockMarkAsRead).toHaveBeenCalled();
  });
});

/**
 * The read surface (list / announcements / conversations / unread-count /
 * :id / :id/thread) now enforces the `messages:read` floor. No internal
 * service reads messages (compliance + billing only POST /messages), so the
 * gate is the plain `requirePermission` — never `requirePermissionOrService`.
 * A custom role that drops `messages:read` must therefore be blocked from
 * every message read.
 */
describe.each([
  ['get', '/'],
  ['get', '/announcements'],
  ['get', '/conversations'],
  ['get', '/unread/count'],
  ['get', '/:id'],
  ['get', '/:id/thread'],
])('%s /messages%s — requires messages:read', (method, path) => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFindPaginated.mockResolvedValue({ data: [], total: 0, limit: 25, offset: 0, hasMore: false });
    // Announcements/conversations are now paginated (return a PaginatedResult, not a bare array).
    mockFindAnnouncements.mockResolvedValue({ data: [], total: 0, limit: 25, offset: 0, hasMore: false });
    mockFindConversations.mockResolvedValue({ data: [], total: 0, limit: 25, offset: 0, hasMore: false });
    mockGetUnreadCount.mockResolvedValue(0);
    mockFindById.mockResolvedValue({ id: 'msg-1', createdAt: '2026-07-01T00:00:00.000Z' });
    mockFindThreadMessages.mockResolvedValue([]);
  });

  it('403s a caller WITHOUT messages:read (service never runs)', async () => {
    const { res, status, json } = makeRes();
    await runRoute(readRouter, method, path, makeReq({
      params: { id: 'msg-1' },
      query: {},
      user: { permissions: [] },
    }), res);

    expect(status).toHaveBeenCalledWith(403);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ code: 'INSUFFICIENT_PERMISSIONS' }));
    expect(mockFindPaginated).not.toHaveBeenCalled();
    expect(mockFindAnnouncements).not.toHaveBeenCalled();
    expect(mockFindConversations).not.toHaveBeenCalled();
    expect(mockFindById).not.toHaveBeenCalled();
  });

  it('lets a caller WITH messages:read through (not 403)', async () => {
    const { res, status } = makeRes();
    await runRoute(readRouter, method, path, makeReq({
      params: { id: 'msg-1' },
      query: {},
      user: { permissions: ['messages:read'] },
    }), res);

    expect(status).not.toHaveBeenCalledWith(403);
    expect(status).toHaveBeenCalledWith(200);
  });
});
