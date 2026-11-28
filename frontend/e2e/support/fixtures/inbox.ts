// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The Inbox's three tabs (`/dashboard/inbox?tab=notifications|messages|access-requests`)
 * with something in each:
 *  - Notifications: a failing pipeline the viewer owns, a pending compliance
 *    exemption, the unread-messages summary and a plugin security fix awaiting
 *    approval;
 *  - Messages: an unread conversation (with a reply in its thread) and a read
 *    platform announcement;
 *  - Access requests: one request waiting for the viewer's decision and one
 *    live read-only session.
 * Every timestamp is relative to {@link INBOX_NOW}.
 */

import { ok, type Backend, type StubUser, OWNER } from '../backend';

/**
 * The moment the fixtures are written against. Pin the page clock here
 * (`page.clock.setFixedTime(INBOX_NOW)`) and every relative time reads the
 * same on every run ("10 min. ago", "in 50 min.").
 */
export const INBOX_NOW = new Date('2026-11-27T09:00:00Z');
const ago = (minutes: number) => new Date(INBOX_NOW.getTime() - minutes * 60_000).toISOString();

export const FAILING_PIPELINE = { id: 'pl-web', project: 'web', organization: 'acme', pipeline_name: 'acme-web-pipeline', total: 12, succeeded: 9, failed: 3, canceled: 0, first_execution: ago(60 * 24 * 26), last_execution: ago(60) };

/** A `Message` row as the messages service serves it (only the fields specs read are typed). */
export type StubMessage = Record<string, unknown> & { id: string; subject: string; content: string };

const message = (over: Record<string, unknown> & { id: string; subject: string; content: string }): StubMessage => ({
  orgId: 'org-2', orgName: 'Globex', threadId: null, recipientOrgId: 'org-1', recipientOrgName: 'Acme', recipientUserId: null,
  messageType: 'conversation', channel: null, readBy: {}, priority: 'normal',
  createdBy: 'u-9', createdAt: ago(90), updatedBy: 'u-9', updatedAt: ago(90),
  isDefault: false, isActive: true,
  ...over,
});

export const CONVERSATION = message({
  id: 'msg-1', subject: 'Shared runner for the Q4 release',
  content: 'Can we borrow your us-east-1 runner for the release window on Friday?', priority: 'high',
});
export const REPLY = message({
  id: 'msg-2', threadId: 'msg-1', orgId: 'org-1', orgName: 'Acme', recipientOrgId: 'org-2', recipientOrgName: 'Globex',
  subject: 'Re: Shared runner for the Q4 release', content: 'Yes — it is free after 18:00 UTC.',
  createdBy: 'u-1', createdAt: ago(30), updatedAt: ago(30), readBy: { 'org-1': ago(30) },
});
export const ANNOUNCEMENT = message({
  id: 'msg-3', orgId: '000000000000000000000001', orgName: 'Pipeline Builder', recipientOrgId: '*', recipientOrgName: undefined,
  messageType: 'announcement', subject: 'Scheduled maintenance on Sunday',
  content: 'The build queue pauses for 30 minutes from 02:00 UTC on Sunday.', readBy: { 'org-1': ago(60 * 20) },
  createdAt: ago(60 * 24), updatedAt: ago(60 * 24),
});

export const ACCESS_REQUEST = {
  id: 'imp-1', status: 'pending', breakglass: false, approverMode: 'user', orgId: 'org-1',
  reason: 'Customer ticket #4821: the pipelines list shows a stale deploy.',
  requester: { id: 'u-sup', name: 'Sam from Support' }, target: { id: OWNER.id, name: OWNER.username },
  createdAt: ago(10), expiresAt: ago(-50),
};
export const LIVE_SESSION = {
  id: 'imp-2', status: 'consumed', breakglass: false, approverMode: 'user', orgId: 'org-1',
  requester: { id: 'u-ops', name: 'Olu from Operations' }, target: { id: 'u-7', name: 'riley' },
  createdAt: ago(20), expiresAt: ago(-10), consumedAt: ago(5), decidedAt: ago(6),
};

const page = <T,>(rows: T[]) => ({ total: rows.length, offset: 0, limit: 25, hasMore: false });

/** Register the inbox's reads (and its writes) on `api`. */
export function stubInbox(api: Backend, user: StubUser = OWNER): void {
  // Notifications.
  api.on('GET /api/pipelines', (call) => (call.query.get('ownerId') === user.id
    ? ok({ pipelines: [{ id: FAILING_PIPELINE.id }], pagination: { total: 1, limit: 1000, offset: 0, hasMore: false } })
    : ok({ pipelines: [], pagination: { total: 0, limit: 25, offset: 0, hasMore: false } })));
  api.on('GET /api/reports/execution/count', ok({ pipelines: [FAILING_PIPELINE] }));
  api.on('GET /api/compliance/exemptions', ok({
    exemptions: [{ id: 'ex-1', orgId: 'org-1', ruleId: 'rule-1', entityType: 'pipeline', entityId: 'pl-web', entityName: 'acme-web-pipeline', reason: 'Legacy base image until the December migration', status: 'pending', createdBy: 'u-2', createdAt: ago(180) }],
    pagination: { total: 1, limit: 20, offset: 0, hasMore: false },
  }));
  api.on('GET /api/plugins/remediations', ok({
    remediations: [{ id: 'rem-1', pluginName: 'node-build', fromVersion: '2.3.0', toVersion: '2.3.1', stage: 'awaiting_approval', cleared: [{ id: 'CVE-2026-0001' }, { id: 'CVE-2026-0002' }], remaining: [], rollout: null }],
    nextCursor: null, enabled: true, severities: ['critical', 'high'], usedToday: 1, maxPerDay: 10,
  }));
  let unread = 1;
  api.on('GET /api/messages/unread/count', () => ok({ count: unread }));

  // Messages.
  const list = (rows: unknown[]) => ok({ messages: rows, pagination: page(rows) });
  api.on('GET /api/messages', list([CONVERSATION, ANNOUNCEMENT]));
  api.on('GET /api/messages/conversations', list([CONVERSATION]));
  api.on('GET /api/messages/announcements', list([ANNOUNCEMENT]));
  api.on(`GET /api/messages/${CONVERSATION.id}`, ok({ message: CONVERSATION }));
  api.on(`GET /api/messages/${CONVERSATION.id}/thread`, ok({ messages: [CONVERSATION, REPLY] }));
  api.on(`GET /api/messages/${ANNOUNCEMENT.id}/thread`, ok({ messages: [ANNOUNCEMENT] }));
  api.on(`PUT /api/messages/${CONVERSATION.id}/thread/read`, () => { unread = 0; return ok({ updated: 1 }); });
  api.on(`PUT /api/messages/${CONVERSATION.id}/read`, () => { unread = 0; return ok({ message: CONVERSATION }); });
  api.on('GET /api/messages/deleted', ok({ messages: [] }));
  api.on('GET /api/messages/support/cases', ok({ cases: [], hasMore: false }));
  api.on('GET /api/messages/support/contacts', ok({ contacts: [] }));
  for (const m of [CONVERSATION, REPLY, ANNOUNCEMENT]) api.on(`GET /api/messages/${m.id}/attachments`, ok({ attachments: [] }));
  api.on(`POST /api/messages/${CONVERSATION.id}/reply`, (call) => ({
    status: 201,
    json: { success: true, data: message({ id: 'msg-4', threadId: CONVERSATION.id, orgId: 'org-1', orgName: 'Acme', recipientOrgId: 'org-2', subject: `Re: ${CONVERSATION.subject}`, content: (call.json as { content: string }).content, createdBy: user.id, createdAt: ago(0), updatedAt: ago(0) }) },
  }));
  api.on('POST /api/messages/notifications/ticket', { status: 503, json: { success: false, message: 'Live updates unavailable' } });

  // Access requests.
  const requests = { 'to-decide': [ACCESS_REQUEST], sessions: [LIVE_SESSION], mine: [] as unknown[] };
  api.on('GET /api/admin/impersonate/requests', (call) => {
    const rows = requests[(call.query.get('view') ?? 'mine') as keyof typeof requests] ?? [];
    return ok({ requests: rows, pagination: page(rows) });
  });
  api.on(`POST /api/admin/impersonate/requests/${ACCESS_REQUEST.id}/decide`, (call) => {
    requests['to-decide'] = [];
    return ok({ requestId: ACCESS_REQUEST.id, status: (call.json as { approve?: boolean })?.approve ? 'approved' : 'denied' });
  });
  api.on(`POST /api/admin/impersonate/requests/${LIVE_SESSION.id}/revoke`, () => {
    requests.sessions = [];
    return ok({ requestId: LIVE_SESSION.id, status: 'revoked', revokedEverywhere: true });
  });
}
