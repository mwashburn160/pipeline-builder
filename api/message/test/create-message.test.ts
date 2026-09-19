// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Handler tests for routes/create-message (POST /messages, POST /:id/reply),
 * including the announcement audit emission and SSE-failure resilience.
 *
 * The reply root lookup MUST be the viewer-scoped `findVisibleById`; the
 * unscoped `findById` is wired to throw so a regression to it fails loudly.
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

const mockFindVisibleById = jest.fn<(...args: unknown[]) => unknown>();
const mockCreate = jest.fn<(...args: unknown[]) => unknown>();

jest.unstable_mockModule('../src/services/message-service.js', () => ({
  messageService: {
    findVisibleById: mockFindVisibleById,
    findById: forbiddenLookup('findById'),
    create: mockCreate,
  },
}));

// Remote-audit spy: route handlers emit attributed `message.*` events via
// getAuditClient().record. Mock the module so tests can assert on the emitted
// event and that NO message body reaches the trail.
const mockAuditRecord = jest.fn();
jest.unstable_mockModule('../src/services/audit.js', () => ({
  getAuditClient: () => ({ record: mockAuditRecord }),
}));

// Cross-tenant send gate. The real helper resolves the account root over HTTP;
// the suite mocks it so tests control reachability directly. Default policy
// mirrors the real helper's fast paths: own org + system org are reachable, any
// other org is NOT (default-closed) — tests that exercise a reachable subtree
// override with `mockResolvedValueOnce(true)`. `clearAllMocks` keeps this base
// implementation (it clears calls, not implementations).
const SYSTEM_ORG = '000000000000000000000001';
const mockIsRecipientReachable = jest.fn<(caller: string, recipient: string) => Promise<boolean>>(
  async (caller: string, recipient: string) => {
    const c = String(caller).toLowerCase();
    const r = String(recipient).toLowerCase();
    return r === c || r === SYSTEM_ORG;
  },
);
// Per-user DM target membership probe. Default: reachable (a member) so existing
// targeted-conversation tests are unaffected; the not-a-member case overrides
// with `mockResolvedValueOnce(false)`.
const mockIsTargetUserReachable = jest.fn<(recipientOrgId: string, userId: string) => Promise<boolean>>(
  async () => true,
);
jest.unstable_mockModule('../src/helpers/org-reachability.js', () => ({
  isRecipientReachable: mockIsRecipientReachable,
  isTargetUserReachable: mockIsTargetUserReachable,
  listReachableOrgs: async () => [],
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

const { sendBadRequest, sendError, isSystemAdmin, isServicePrincipal, sendEntityNotFound } = await import('@pipeline-builder/api-core');
const { createCreateMessageRoutes } = await import('../src/routes/create-message.js');

const mockSseManager = createMockSseManager();
const createRouter = createCreateMessageRoutes(mockSseManager);

describe('POST /messages (create)', () => {
  const handler = getHandler(createRouter, 'post', '/');

  beforeEach(() => jest.clearAllMocks());

  it('creates a message and returns 201', async () => {
    const created = { id: 'msg-new', subject: 'New message' };
    mockCreate.mockResolvedValue(created);

    const req = mockReq({
      body: {
        recipientOrgId: '000000000000000000000001',
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
      '000000000000000000000001',
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

  it('persists recipientUserId on a per-user targeted conversation', async () => {
    mockCreate.mockResolvedValue({ id: 'msg-dm' });
    const req = mockReq({
      body: {
        recipientOrgId: '000000000000000000000001',
        recipientUserId: 'user-42',
        messageType: 'conversation',
        subject: 'Just for you',
        content: 'private note',
        priority: 'normal',
      },
    });
    const res = mockRes();
    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(201);
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ recipientUserId: 'user-42' }),
      expect.anything(),
    );
    // Targeted sends redact the subject from the org-wide SSE fan-out AND omit
    // recipientUserId (which would leak WHICH user was targeted to the org).
    expect(mockSseManager.send).toHaveBeenCalledWith(
      '000000000000000000000001',
      'MESSAGE',
      'New message',
      expect.objectContaining({ action: 'NEW_MESSAGE', subject: undefined }),
    );
    const sseArg = (mockSseManager.send as jest.Mock).mock.calls.at(-1)?.[3] as Record<string, unknown>;
    expect(sseArg).not.toHaveProperty('recipientUserId');
  });

  it('rejects a per-user DM addressed to a non-member of the recipient org', async () => {
    mockIsTargetUserReachable.mockResolvedValueOnce(false);
    const req = mockReq({
      body: {
        recipientOrgId: '000000000000000000000001',
        recipientUserId: 'ghost-user',
        messageType: 'conversation',
        subject: 'Just for you',
        content: 'private note',
        priority: 'normal',
      },
    });
    const res = mockRes();
    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('defaults recipientUserId to null for an org-wide conversation', async () => {
    mockCreate.mockResolvedValue({ id: 'msg-orgwide' });
    const req = mockReq({
      body: {
        recipientOrgId: '000000000000000000000001',
        messageType: 'conversation',
        subject: 'Everyone',
        content: 'hello team',
        priority: 'normal',
      },
    });
    const res = mockRes();
    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(201);
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ recipientUserId: null }),
      expect.anything(),
    );
  });

  it('links attachmentIds to the created message', async () => {
    mockCreate.mockResolvedValue({ id: 'msg-att' });
    mockLinkToMessage.mockResolvedValue([{ id: 'att-1' }]);
    const req = mockReq({
      body: {
        recipientOrgId: '000000000000000000000001',
        messageType: 'conversation',
        subject: 'With file',
        content: 'see attached',
        priority: 'normal',
        attachmentIds: ['att-1'],
      },
    });
    const res = mockRes();
    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(201);
    expect(mockLinkToMessage).toHaveBeenCalledWith(['att-1'], 'msg-att', expect.any(String), expect.any(String));
  });

  it('rejects recipientUserId on an announcement (broadcast is org-wide)', async () => {
    (isSystemAdmin as jest.Mock).mockReturnValue(true);
    const req = mockReq({
      body: {
        recipientOrgId: '*',
        recipientUserId: 'user-42',
        messageType: 'announcement',
        subject: 'Broadcast',
        content: 'to everyone',
        priority: 'normal',
      },
    });
    const res = mockRes();
    await handler(req, res);

    expect(sendBadRequest).toHaveBeenCalledWith(
      res,
      'recipientUserId is only valid on a conversation to a specific organization',
      'VALIDATION_ERROR',
    );
    expect(mockCreate).not.toHaveBeenCalled();
  });

  // Tenant-boundary guard (#20): '*' is a BROADCAST recipient reserved for
  // announcements. A conversation must never target '*' for ANY caller — a
  // '*'-recipient conversation lands in every org's inbox (an un-audited
  // broadcast) and the reachability gate can't catch it (sysadmins/service
  // principals skip the gate; '*' short-circuits reachability anyway).
  it.each([
    ['a regular member', false, false],
    ['a sysadmin', true, false],
    ['a service principal', false, true],
  ])('rejects a conversation with recipientOrgId="*" for %s (400, no row created)', async (_who, sysadmin, service) => {
    (isSystemAdmin as jest.Mock).mockReturnValue(sysadmin);
    (isServicePrincipal as jest.Mock).mockReturnValue(service);

    const req = mockReq({
      body: {
        recipientOrgId: '*',
        messageType: 'conversation',
        subject: 'Sneaky broadcast',
        content: 'Content',
        priority: 'normal',
      },
    });
    const res = mockRes();
    await handler(req, res);

    expect(sendBadRequest).toHaveBeenCalledWith(
      res,
      'Conversations cannot use "*" as recipientOrgId; "*" is reserved for announcement broadcasts',
      'VALIDATION_ERROR',
    );
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('returns 403 when non-sysadmin creates announcement', async () => {
    (isSystemAdmin as jest.Mock).mockReturnValue(false);
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
      'Only sysadmins can create announcements',
      'INSUFFICIENT_PERMISSIONS',
    );
  });

  it('allows sysadmins to create announcements', async () => {
    (isSystemAdmin as jest.Mock).mockReturnValue(true);
    mockCreate.mockResolvedValue({ id: 'msg-ann', subject: 'Update' });

    const req = mockReq({
      body: {
        recipientOrgId: '*',
        messageType: 'announcement',
        subject: 'Update',
        content: 'System-wide update',
        priority: 'normal',
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

  it('allows a member to start a conversation with their own org', async () => {
    (isSystemAdmin as jest.Mock).mockReturnValue(false);
    mockCreate.mockResolvedValue({ id: 'msg-self', subject: 'Hello' });

    // ctx.identity.orgId is 'ORG-1' → normalized to 'org-1' by withRoute.
    const req = mockReq({
      body: {
        recipientOrgId: 'org-1',
        messageType: 'conversation',
        subject: 'Hello',
        content: 'Content',
        priority: 'normal',
      },
    });
    const res = mockRes();
    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(201);
    expect(mockCreate).toHaveBeenCalled();
  });

  it('blocks a member from messaging an unrelated / arbitrary org (403, no row created)', async () => {
    // Cross-tenant injection guard: an org outside the caller's account (and
    // not the system support inbox) is unreachable → 403, and NO row is
    // created. The default mock reachability denies any non-own/non-system org.
    (isSystemAdmin as jest.Mock).mockReturnValue(false);
    (isServicePrincipal as jest.Mock).mockReturnValue(false);

    const req = mockReq({
      body: {
        recipientOrgId: 'unrelated-victim-org',
        messageType: 'conversation',
        subject: 'Spam',
        content: 'Content',
        priority: 'normal',
      },
    });
    const res = mockRes();
    await handler(req, res);

    expect(sendError).toHaveBeenCalledWith(
      res,
      403,
      'You cannot send a message to that organization',
      'INSUFFICIENT_PERMISSIONS',
    );
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('allows a member to message a reachable org in their account subtree', async () => {
    // Same-account (shared root org) recipient → reachability resolves true.
    (isSystemAdmin as jest.Mock).mockReturnValue(false);
    (isServicePrincipal as jest.Mock).mockReturnValue(false);
    mockIsRecipientReachable.mockResolvedValueOnce(true);
    mockCreate.mockResolvedValue({ id: 'msg-sibling', subject: 'Hello' });

    const req = mockReq({
      body: {
        recipientOrgId: 'sibling-team-org',
        messageType: 'conversation',
        subject: 'Hello',
        content: 'Content',
        priority: 'normal',
      },
    });
    const res = mockRes();
    await handler(req, res);

    expect(mockIsRecipientReachable).toHaveBeenCalledWith('org-1', 'sibling-team-org');
    expect(res.status).toHaveBeenCalledWith(201);
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        recipientOrgId: 'sibling-team-org',
        messageType: 'conversation',
      }),
      expect.anything(),
    );
  });

  it('allows a sysadmin to target any org, bypassing the reachability gate', async () => {
    (isSystemAdmin as jest.Mock).mockReturnValue(true);
    (isServicePrincipal as jest.Mock).mockReturnValue(false);
    mockCreate.mockResolvedValue({ id: 'msg-admin-cross', subject: 'Hello' });

    const req = mockReq({
      body: {
        recipientOrgId: 'any-unrelated-org',
        messageType: 'conversation',
        subject: 'Hello',
        content: 'Content',
        priority: 'normal',
      },
    });
    const res = mockRes();
    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(201);
    // Gate is skipped entirely for sysadmins — no reachability lookup.
    expect(mockIsRecipientReachable).not.toHaveBeenCalled();
  });

  it('allows a service principal to target any org, bypassing the reachability gate', async () => {
    (isSystemAdmin as jest.Mock).mockReturnValue(false);
    (isServicePrincipal as jest.Mock).mockReturnValue(true);
    mockCreate.mockResolvedValue({ id: 'msg-svc-cross', subject: 'Hello' });

    const req = mockReq({
      body: {
        recipientOrgId: 'any-unrelated-org',
        messageType: 'conversation',
        subject: 'Hello',
        content: 'Content',
        priority: 'normal',
      },
    });
    const res = mockRes();
    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(201);
    expect(mockIsRecipientReachable).not.toHaveBeenCalled();
  });

  it('returns 500 on service error', async () => {
    mockCreate.mockRejectedValue(new Error('DB error'));

    const req = mockReq({
      body: {
        recipientOrgId: '000000000000000000000001',
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
      expect.objectContaining({ recipientOrgId: '000000000000000000000001' }),
      'user-1',
    );
    expect(mockSseManager.send).toHaveBeenCalledWith(
      '000000000000000000000001',
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
      expect.objectContaining({ recipientOrgId: '000000000000000000000001' }),
      'user-1',
    );
  });

  it('does not resolve non-alias recipient org IDs', async () => {
    mockCreate.mockResolvedValue({ id: 'msg-direct', subject: 'Direct message' });

    const req = mockReq({
      body: {
        recipientOrgId: '000000000000000000000001',
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
      expect.objectContaining({ recipientOrgId: '000000000000000000000001' }),
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
      recipientOrgId: '000000000000000000000001',
      messageType: 'conversation',
      subject: 'Original',
      priority: 'normal',
    };
    mockFindVisibleById.mockResolvedValue(rootMessage);
    mockCreate.mockResolvedValue({ id: 'msg-reply', threadId: 'msg-1' });

    const req = mockReq({
      params: { id: 'msg-1' },
      body: { content: 'Reply text' },
    });
    const res = mockRes();
    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(201);
    // Root is loaded viewer-scoped so a non-target member can't reply into a
    // private thread (never the unscoped findById).
    expect(mockFindVisibleById).toHaveBeenCalledWith('msg-1', 'org-1');
    // Verify SSE notification sent to reply recipient
    expect(mockSseManager.send).toHaveBeenCalledWith(
      '000000000000000000000001',
      'MESSAGE',
      'New reply',
      expect.objectContaining({ action: 'NEW_MESSAGE', messageId: 'msg-reply', threadId: 'msg-1' }),
    );
  });

  // #23: a reply is ALWAYS a conversation, even when the root is an announcement.
  // Copying rootMessage.messageType persisted `announcement`-typed rows authored
  // by non-sysadmins (a member replying to a broadcast), polluting messageType
  // filters + the announcements feed. Replies must persist as `conversation`.
  it('persists an announcement reply as messageType="conversation" (not announcement)', async () => {
    (isSystemAdmin as jest.Mock).mockReturnValue(false);
    const rootAnnouncement = {
      id: 'ann-1',
      orgId: '000000000000000000000001', // system org broadcast
      recipientOrgId: '*',
      messageType: 'announcement',
      subject: 'System-wide notice',
      priority: 'normal',
    };
    mockFindVisibleById.mockResolvedValue(rootAnnouncement);
    mockCreate.mockResolvedValue({ id: 'reply-1', threadId: 'ann-1' });

    // Caller org 'org-1' is a broadcast recipient → allowed to reply (goes to system org).
    const req = mockReq({
      params: { id: 'ann-1' },
      body: { content: 'A member replying to the broadcast' },
    });
    const res = mockRes();
    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(201);
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: 'ann-1',
        messageType: 'conversation',
        recipientOrgId: '000000000000000000000001', // reply routes back to the system org
      }),
      'user-1',
    );
    // SSE notification carries the reply's (conversation) type too.
    expect(mockSseManager.send).toHaveBeenCalledWith(
      '000000000000000000000001',
      'MESSAGE',
      'New reply',
      expect.objectContaining({ messageType: 'conversation' }),
    );
  });

  it('returns 404 when root message not found', async () => {
    mockFindVisibleById.mockResolvedValue(null);

    const req = mockReq({
      params: { id: 'nonexistent' },
      body: { content: 'Reply text' },
    });
    const res = mockRes();
    await handler(req, res);

    expect(sendEntityNotFound).toHaveBeenCalledWith(res, 'Message');
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
    mockFindVisibleById.mockResolvedValue(rootMessage);

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

  it('returns 400 when target message is itself a reply (thread-root invariant)', async () => {
    // The reader walks `threadId === root.id`, so a reply-to-reply would
    // create an orphan grandchild. Force the client to reply to the root.
    const replyMessage = {
      id: 'msg-2',
      orgId: 'org-1',
      recipientOrgId: '000000000000000000000001',
      threadId: 'msg-1', // <-- this message IS already a reply
      messageType: 'conversation',
      subject: 'Re: Original',
      priority: 'normal',
    };
    mockFindVisibleById.mockResolvedValue(replyMessage);

    const req = mockReq({
      params: { id: 'msg-2' },
      body: { content: 'reply to reply' },
    });
    const res = mockRes();
    await handler(req, res);

    expect(sendBadRequest).toHaveBeenCalledWith(
      res,
      expect.stringMatching(/Cannot reply to a reply/),
      'VALIDATION_ERROR',
    );
    expect(mockCreate).not.toHaveBeenCalled();
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

// Remote audit emissions
//
// Message audit is intentionally scoped to ADMIN BROADCASTS and DELETES, NOT
// 1:1 user messages (noisy + would pull private content into the trail). The
// `details` payload must carry SAFE METADATA ONLY — never the message body.

describe('Remote audit emissions (create)', () => {
  const createHandler = getHandler(createRouter, 'post', '/');

  beforeEach(() => jest.clearAllMocks());

  it('emits message.announcement.create with metadata (no body) on announcement create', async () => {
    (isSystemAdmin as jest.Mock).mockReturnValue(true);
    mockCreate.mockResolvedValue({ id: 'msg-ann', subject: 'Update' });

    const req = mockReq({
      user: { sub: 'admin-9' },
      body: {
        recipientOrgId: '*',
        messageType: 'announcement',
        subject: 'Update',
        content: 'SECRET announcement body that must never be audited',
        priority: 'normal',
      },
    });
    const res = mockRes();
    await createHandler(req, res);

    expect(res.status).toHaveBeenCalledWith(201);
    expect(mockAuditRecord).toHaveBeenCalledTimes(1);
    expect(mockAuditRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'message.announcement.create',
        actorId: 'admin-9',
        orgId: 'org-1',
        targetId: 'msg-ann',
        details: expect.objectContaining({
          subject: 'Update',
          messageType: 'announcement',
          recipientScope: 'org-wide',
        }),
      }),
      'message',
    );

    // No message body/content may reach the audit trail.
    const [event] = mockAuditRecord.mock.calls[0] as [any, string];
    expect(JSON.stringify(event)).not.toContain('SECRET announcement body');
    expect(event.details).not.toHaveProperty('content');
  });

  it('does NOT emit audit for a 1:1 conversation create', async () => {
    (isSystemAdmin as jest.Mock).mockReturnValue(false);
    mockCreate.mockResolvedValue({ id: 'msg-conv', subject: 'Hello' });

    const req = mockReq({
      body: {
        recipientOrgId: '000000000000000000000001',
        messageType: 'conversation',
        subject: 'Hello',
        content: 'private 1:1 content',
        priority: 'normal',
      },
    });
    const res = mockRes();
    await createHandler(req, res);

    expect(res.status).toHaveBeenCalledWith(201);
    expect(mockAuditRecord).not.toHaveBeenCalled();
  });
});

// SSE Notification Resilience

describe('SSE notification resilience (create)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('does not fail HTTP response if SSE send throws on message create', async () => {
    mockSseManager.send.mockImplementation(() => { throw new Error('SSE failure'); });
    mockCreate.mockResolvedValue({ id: 'msg-1', subject: 'Test' });

    const handler = getHandler(createRouter, 'post', '/');
    const req = mockReq({
      body: {
        recipientOrgId: '000000000000000000000001',
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

  it('does not fail HTTP response if SSE broadcast throws on announcement', async () => {
    mockSseManager.broadcast.mockImplementation(() => { throw new Error('SSE failure'); });
    // The announcement path requires a sysadmin caller (previously inherited
    // from an earlier suite's leaked mock state).
    (isSystemAdmin as jest.Mock).mockReturnValue(true);
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
        identity: { orgId: '000000000000000000000001', userId: 'admin' },
        log: jest.fn(),
        requestId: 'req-1',
      },
    });
    const res = mockRes();
    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(201);
  });
});
