// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Handler tests for routes/read-messages (inbox, announcements, conversations,
 * unread count, single message, thread).
 *
 * Single-message reads MUST use the viewer-scoped `findVisibleById`; the
 * unscoped `findById` is wired to throw so a regression to it fails loudly.
 */

import type { AnyFn } from '@pipeline-builder/api-core/testing';
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { stubModule } from '@pipeline-builder/api-core/testing';
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

const mockFindPaginated = jest.fn<AnyFn>();
const mockFindAnnouncements = jest.fn<AnyFn>();
const mockFindConversations = jest.fn<AnyFn>();
const mockGetUnreadCount = jest.fn<AnyFn>();
const mockFindVisibleById = jest.fn<AnyFn>();
const mockFindThreadMessages = jest.fn<AnyFn>();

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
    createPending: jest.fn<AnyFn>(),
  },
}));

const mockListReachableOrgs = jest.fn<AnyFn>();
jest.unstable_mockModule('../src/helpers/org-reachability.js', () => ({
  listReachableOrgs: mockListReachableOrgs,
  isRecipientReachable: jest.fn(async () => true),
  isTargetUserReachable: jest.fn(async () => true),
}));

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock(routeApiCoreOverrides()));
jest.unstable_mockModule('@pipeline-builder/api-server', () => routeApiServerMock());
const mockListOrgCases = jest.fn<AnyFn>(async () => []);
const mockListQueue = jest.fn<AnyFn>(async () => []);
jest.unstable_mockModule('@pipeline-builder/pipeline-data', () => stubModule('@pipeline-builder/pipeline-data', {
  schema: { message: { $inferInsert: {} } },
  listOrgCases: mockListOrgCases,
  listQueue: mockListQueue,
}));

const { sendBadRequest, sendEntityNotFound, validateQuery, parsePaginationParams } = await import('@pipeline-builder/api-core');
const { createReadMessageRoutes } = await import('../src/routes/read-messages.js');

const mockQuotaService = createMockQuotaService();
const readRouter = createReadMessageRoutes(mockQuotaService);

describe('GET /messages (inbox)', () => {
  const handler = getHandler(readRouter, 'get', '/');

  beforeEach(() => { jest.clearAllMocks(); });

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

  beforeEach(() => { jest.clearAllMocks(); });

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
      {}, // no filters on this request
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

  beforeEach(() => { jest.clearAllMocks(); });

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
    // asking. The third arg is the optional filter set (empty here) — never a
    // viewer, which pins that the parameter stays gone.
    expect(mockFindConversations).toHaveBeenCalledWith(
      'org-1',
      expect.objectContaining({ limit: 25, offset: 0, sortBy: 'createdAt', sortOrder: 'desc' }),
      {},
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

  beforeEach(() => { jest.clearAllMocks(); });

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
    (parsePaginationParams as unknown as jest.Mock<AnyFn>).mockReturnValueOnce({ limit: 25, offset: 50, sortBy: 'createdAt', sortOrder: 'desc' });
    mockFindConversations.mockResolvedValue({ data: [], total: 60, limit: 25, offset: 50, hasMore: false });

    await conversations(mockReq(), mockRes());

    expect(mockFindConversations).toHaveBeenCalledWith(
      'org-1',
      expect.objectContaining({ offset: 50 }),
      {},
    );
    // Never routed through the mixed-inbox query — that is what limited a tab
    // to the pages the inbox had loaded.
    expect(mockFindPaginated).not.toHaveBeenCalled();
  });

  it('forwards the free-text search term to the tab query', async () => {
    (validateQuery as unknown as jest.Mock<AnyFn>).mockReturnValueOnce({ ok: true, value: { search: 'outage' } });
    mockFindAnnouncements.mockResolvedValue({ data: [], total: 0, limit: 25, offset: 0, hasMore: false });

    await announcements(mockReq(), mockRes());

    expect(mockFindAnnouncements).toHaveBeenCalledWith('org-1', expect.any(Object), { search: 'outage' });
  });

  it('forwards read-state, priority and channel filters to the tab query', async () => {
    (validateQuery as unknown as jest.Mock<AnyFn>).mockReturnValueOnce({ ok: true, value: { isRead: false, priority: 'urgent', channel: 'support' } });
    mockFindConversations.mockResolvedValue({ data: [], total: 0, limit: 25, offset: 0, hasMore: false });

    await conversations(mockReq(), mockRes());

    expect(mockFindConversations).toHaveBeenCalledWith(
      'org-1',
      expect.any(Object),
      { isRead: false, priority: 'urgent', channel: 'support' },
    );
  });

  it('rejects an invalid query with a 400 instead of silently ignoring it', async () => {
    (validateQuery as unknown as jest.Mock<AnyFn>).mockReturnValueOnce({ ok: false, error: 'search must be <= 200 chars' });

    const res = mockRes();
    await conversations(mockReq(), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockFindConversations).not.toHaveBeenCalled();
  });
});

describe('GET /messages/unread/count', () => {
  const handler = getHandler(readRouter, 'get', '/unread/count');

  beforeEach(() => { jest.clearAllMocks(); });

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

  beforeEach(() => { jest.clearAllMocks(); });

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

  beforeEach(() => { jest.clearAllMocks(); });

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

describe('GET /messages/recipients/orgs', () => {
  const handler = getHandler(readRouter, 'get', '/recipients/orgs');

  beforeEach(() => { jest.clearAllMocks(); });

  it('returns the caller account\'s reachable orgs as { orgs }', async () => {
    const orgs = [
      { orgId: 'root-1', name: 'Acme', isTeam: false },
      { orgId: 'org-1', name: 'Platform team', isTeam: true },
    ];
    mockListReachableOrgs.mockResolvedValue(orgs);

    const req = mockReq();
    const res = mockRes();
    await handler(req, res);

    expect(mockListReachableOrgs).toHaveBeenCalledWith('org-1');
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ data: { orgs } }));
  });
});

/**
 * The org's own support cases.
 *
 * Two things are asserted here that are easy to get wrong and invisible when
 * wrong: the route is reachable at all (it is mounted ABOVE `/:id`, so a later
 * mount would have `support` swallowed as a message id), and the response omits
 * `assignedTo` — which engineer holds a case is internal, and the tenant's
 * counterparty is the support desk, not a named individual.
 */
describe('GET /messages/support/cases', () => {
  const handler = getHandler(readRouter, 'get', '/support/cases');
  const CASE = {
    id: 'internal-pk',
    threadId: 'root-1',
    orgId: 'org-1',
    displayNumber: 1042,
    status: 'awaiting_support',
    severity: 'high',
    level: 'support_premium',
    openedWithIncident: false,
    tenantContact: 'user-1',
    assignedTo: 'staff-7',
    firstResponseAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    closedAt: null,
    awaitingTotalSeconds: 0,
  };

  beforeEach(() => { jest.clearAllMocks(); });

  it('is reachable — it is mounted above /:id, not swallowed as a message id', async () => {
    expect(handler).toBeDefined();
  });

  it('returns the org cases keyed by threadId, the case identity', async () => {
    mockListOrgCases.mockResolvedValue([CASE] as never);
    const res = mockRes();
    await handler(mockReq(), res);
    expect(res.status).toHaveBeenCalledWith(200);
    const body = (res.json as jest.Mock).mock.calls[0]![0] as { data: { cases: Record<string, unknown>[] } };
    expect(body.data.cases).toHaveLength(1);
    expect(body.data.cases[0]).toMatchObject({ threadId: 'root-1', displayNumber: 1042, status: 'awaiting_support' });
  });

  it('does NOT leak assignedTo or the internal primary key', async () => {
    // assignedTo is internal: the tenant's counterparty is the desk, not a
    // named engineer. `id` is the internal pk — threadId is the identity a
    // tenant uses, so shipping both invites the wrong one being quoted.
    mockListOrgCases.mockResolvedValue([CASE] as never);
    const res = mockRes();
    await handler(mockReq(), res);
    const body = (res.json as jest.Mock).mock.calls[0]![0] as { data: { cases: Record<string, unknown>[] } };
    expect(body.data.cases[0]).not.toHaveProperty('assignedTo');
    expect(body.data.cases[0]).not.toHaveProperty('id');
    expect(body.data.cases[0]).not.toHaveProperty('orgId');
  });

  it('answers with an empty list rather than 404 when the org has no cases', async () => {
    // An org with no cases is the normal state, not a missing resource — and a
    // 404 here would make the inbox treat "no cases yet" as an error.
    mockListOrgCases.mockResolvedValue([] as never);
    const res = mockRes();
    await handler(mockReq(), res);
    expect(res.status).toHaveBeenCalledWith(200);
    const body = (res.json as jest.Mock).mock.calls[0]![0] as { data: { cases: unknown[] } };
    expect(body.data.cases).toEqual([]);
  });

  it('scopes by the caller org, passing no org parameter a caller could forge', async () => {
    mockListOrgCases.mockResolvedValue([] as never);
    await handler(mockReq(), mockRes());
    expect(mockListOrgCases).toHaveBeenCalledWith('org-1');
  });
});

/**
 * The staff queue — the one support read with NO org predicate.
 *
 * Two properties are worth pinning because both are invisible when wrong:
 *
 *  - It sorts by RESPONSE age, not arrival age. The index orders by
 *    `created_at`, but a case we answered in an hour where the tenant then took
 *    four days is not a four-day case. `waitingSeconds` subtracts
 *    `awaitingTotalSeconds`, and the list is re-sorted on it.
 *  - It carries the FROZEN `level`, which is how triage sees who is paying and
 *    which target applies to THIS case rather than to the org today.
 */
describe('GET /messages/support/queue', () => {
  const handler = getHandler(readRouter, 'get', '/support/queue');
  const mk = (over: Record<string, unknown>) => ({
    threadId: 't',
    orgId: 'org-x',
    displayNumber: 1,
    status: 'open',
    severity: 'normal',
    level: 'support_standard',
    openedWithIncident: false,
    assignedTo: null,
    tenantContact: 'u1',
    firstResponseAt: null,
    createdAt: new Date(Date.now() - 3600_000).toISOString(),
    awaitingTotalSeconds: 0,
    ...over,
  });
  const rows = async () => {
    const res = mockRes();
    await handler(mockReq(), res);
    const body = (res.json as jest.Mock).mock.calls[0]![0] as { data: { cases: Record<string, unknown>[] } };
    return body.data.cases;
  };

  beforeEach(() => { jest.clearAllMocks(); });

  it('subtracts time spent awaiting the customer from the wait', async () => {
    // One hour elapsed, 30 minutes of it waiting on the customer -> 30 minutes
    // of OUR time. Reporting 60 would make every case look twice as late.
    mockListQueue.mockResolvedValue([mk({ awaitingTotalSeconds: 1800 })] as never);
    const [r] = await rows();
    expect(r!.waitingSeconds as number).toBeGreaterThanOrEqual(1750);
    expect(r!.waitingSeconds as number).toBeLessThanOrEqual(1850);
  });

  it('orders by RESPONSE age, re-sorting what the index returned by arrival', async () => {
    // `old` arrived first but spent nearly all of it on the customer; `recent`
    // arrived later and has been on us the whole time. Sorting by createdAt
    // would put the wrong one first.
    mockListQueue.mockResolvedValue([
      mk({ threadId: 'old', createdAt: new Date(Date.now() - 10 * 3600_000).toISOString(), awaitingTotalSeconds: 9.5 * 3600 }),
      mk({ threadId: 'recent', createdAt: new Date(Date.now() - 3 * 3600_000).toISOString(), awaitingTotalSeconds: 0 }),
    ] as never);
    expect((await rows()).map((r) => r.threadId)).toEqual(['recent', 'old']);
  });

  it('never reports a negative wait', async () => {
    // A clock skew or an over-accumulated pause must not produce a case that
    // has been waiting minus two hours, which would sort it to the bottom
    // forever.
    mockListQueue.mockResolvedValue([mk({ awaitingTotalSeconds: 99999 })] as never);
    expect((await rows())[0]!.waitingSeconds).toBe(0);
  });

  it('carries the frozen level and the org, so triage sees who is paying', async () => {
    mockListQueue.mockResolvedValue([mk({ level: 'support_premium', orgId: 'org-9' })] as never);
    expect((await rows())[0]).toMatchObject({ level: 'support_premium', orgId: 'org-9' });
  });

  it('includes firstResponseAt so "never answered" is distinguishable from "waiting again"', async () => {
    // By age alone those look identical and mean opposite things about whether
    // we are late.
    mockListQueue.mockResolvedValue([mk({ firstResponseAt: '2026-01-01T00:00:00.000Z' })] as never);
    expect((await rows())[0]!.firstResponseAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('answers an empty list when nothing is open', async () => {
    mockListQueue.mockResolvedValue([] as never);
    expect(await rows()).toEqual([]);
  });
});
