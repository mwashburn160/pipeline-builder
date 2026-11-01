// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import {
  sendBadRequest,
  sendSuccess,
  sendPaginatedNested,
  requireSystemAdmin,
  ErrorCode,
  parsePaginationParams,
  getParam,
  requirePermission,
  validateQuery,
  MessageFilterSchema,
  sendEntityNotFound,
} from '@pipeline-builder/api-core';
import type { QuotaService } from '@pipeline-builder/api-core';
import { withRoute, meterQuotaOnSuccess, createProtectedRoute } from '@pipeline-builder/api-server';
import type { RequestHandler } from 'express';
import { listActiveSupportContacts, listOrgCases, listQueue } from '@pipeline-builder/pipeline-data';
import type { MessageFilter } from '@pipeline-builder/pipeline-data';
import { Router } from 'express';
import { enrichOneWithOrgNames, enrichWithOrgNames } from '../helpers/org-names.js';
import { listReachableOrgs } from '../helpers/org-reachability.js';
import { attachmentService } from '../services/attachment-service.js';
import { messageService, type InboxFilters } from '../services/message-service.js';

/** The tab-view filters from a validated query — absent keys stay absent. */
function inboxFiltersOf(v: { search?: string; isRead?: boolean; priority?: InboxFilters['priority']; channel?: string }): InboxFilters {
  return {
    ...(v.search && { search: v.search }),
    ...(v.isRead !== undefined && { isRead: v.isRead }),
    ...(v.priority && { priority: v.priority }),
    ...(v.channel && { channel: v.channel }),
  };
}

/**
 * Create read routes for the message service.
 *
 * Routes:
 *   GET /messages              — List inbox (root messages), paginated
 *   GET /messages/announcements — List announcements only
 *   GET /messages/conversations — List conversations only
 *   GET /messages/unread/count  — Get unread message count
 *   GET /messages/recipients/orgs — Orgs the caller may start a conversation with
 *   GET /messages/:id           — Get single message by ID
 *   GET /messages/:id/thread    — Get all messages in a thread
 */
/** Most cases one export may carry. Bounded so a file request cannot become a
 *  whole-history scan; an org past it is one that should be asking for a report. */
const EXPORT_MAX = 5000;

/**
 * One CSV cell.
 *
 * Quotes only when it has to and doubles an embedded quote, which is the whole
 * of RFC 4180 that these fields can reach: every value exported is a number, an
 * enum or an ISO timestamp, so the delimiter is the only real hazard. Guarding
 * it anyway rather than trusting that, because the day somebody adds a free-text
 * column is the day an unquoted comma shifts every later column by one.
 */
function csvCell(value: unknown): string {
  const text = String(value ?? '');
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function createReadMessageRoutes(quotaService: QuotaService): Router {
  const router = Router();
  // apiCalls metering: once per 2xx, never for service principals.
  const meter = meterQuotaOnSuccess(quotaService, 'apiCalls');
  const protect = createProtectedRoute(quotaService, 'apiCalls');

  // GET /messages — List inbox (root messages)
  router.get('/', meter, ...protect, requirePermission('messages:read'), withRoute(async ({ req, res, ctx, orgId, userId }) => {
    const { limit, offset, sortBy, sortOrder } = parsePaginationParams(req.query);

    // Validate query params with Zod schema
    const validation = validateQuery(req, MessageFilterSchema);
    if (!validation.ok) {
      return sendBadRequest(res, validation.error, ErrorCode.VALIDATION_ERROR);
    }
    const { messageType, priority, channel, isRead, threadId, search } = validation.value;

    ctx.log('INFO', 'Fetching messages inbox', { orgId, messageType, channel, isRead, search: search ? '(set)' : undefined });

    // `threadId === 'root'` (sentinel) or `null` both mean "root messages only".
    // Any UUID value is forwarded literally to filter replies in a thread.
    const resolvedThreadId = threadId === 'root' || threadId === null ? null : threadId;

    const filter: Partial<MessageFilter> = {
      isActive: true,
      threadId: resolvedThreadId ?? null,
      // Scope per-user targeted messages to this viewer (org-wide rows are
      // unaffected; a message addressed to another member won't surface here).
      ...(userId && { viewerUserId: userId }),
      ...(messageType && { messageType }),
      ...(priority && { priority }),
      ...(channel && { channel }),
      ...(isRead !== undefined && { isRead }),
      ...(search && { search }),
    };

    const result = await messageService.findPaginated(
      filter,
      orgId,
      { limit, offset, sortBy: sortBy || 'createdAt', sortOrder: sortOrder || 'desc' },
    );

    ctx.log('COMPLETED', 'Messages fetched', { count: result.data.length, total: result.total });

    // Label each row with the counterparty org's NAME (the UI renders names, not
    // ids). Best-effort: a resolution failure leaves the id for the client to show.
    const messages = await enrichWithOrgNames(result.data);
    return sendPaginatedNested(res, 'messages', messages, {
      total: result.total, limit: result.limit, offset: result.offset, hasMore: result.hasMore,
    });
  }));

  // GET /messages/announcements — List announcements (paginated + hard-capped,
  // mirroring the `/` inbox — the service clamps limit to MAX_PAGE_LIMIT so this
  // can never fetch/cache an unbounded set).
  //
  // This is the endpoint the UI's "Announcements" tab drives. It accepts the same
  // `search` / `isRead` / `priority` / `channel` filters the `/` inbox does, so a
  // tab is filtered SERVER-side over the whole corpus (with its own
  // `total`/`hasMore`) instead of client-side over whichever inbox pages
  // happened to be loaded.
  router.get('/announcements', meter, ...protect, requirePermission('messages:read'), withRoute(async ({ req, res, ctx, orgId }) => {
    const { limit, offset, sortBy, sortOrder } = parsePaginationParams(req.query);
    const validation = validateQuery(req, MessageFilterSchema);
    if (!validation.ok) {
      return sendBadRequest(res, validation.error, ErrorCode.VALIDATION_ERROR);
    }
    const filters = inboxFiltersOf(validation.value);
    ctx.log('INFO', 'Fetching announcements', { orgId, ...filters, search: filters.search ? '(set)' : undefined });
    const result = await messageService.findAnnouncements(orgId, {
      limit, offset, sortBy: sortBy || 'createdAt', sortOrder: sortOrder || 'desc',
    }, filters);

    ctx.log('COMPLETED', 'Announcements fetched', { count: result.data.length });

    const messages = await enrichWithOrgNames(result.data);
    return sendPaginatedNested(res, 'messages', messages, {
      total: result.total, limit: result.limit, offset: result.offset, hasMore: result.hasMore,
    });
  }));

  // GET /messages/conversations — List conversations (paginated + hard-capped).
  // Drives the UI's "Conversations" tab; same server-side filters as
  // /announcements above.
  router.get('/conversations', meter, ...protect, requirePermission('messages:read'), withRoute(async ({ req, res, ctx, orgId }) => {
    const { limit, offset, sortBy, sortOrder } = parsePaginationParams(req.query);
    const validation = validateQuery(req, MessageFilterSchema);
    if (!validation.ok) {
      return sendBadRequest(res, validation.error, ErrorCode.VALIDATION_ERROR);
    }
    const filters = inboxFiltersOf(validation.value);
    ctx.log('INFO', 'Fetching conversations', { orgId, ...filters, search: filters.search ? '(set)' : undefined });
    const result = await messageService.findConversations(orgId, {
      limit, offset, sortBy: sortBy || 'createdAt', sortOrder: sortOrder || 'desc',
    }, filters);

    ctx.log('COMPLETED', 'Conversations fetched', { count: result.data.length });

    const messages = await enrichWithOrgNames(result.data);
    return sendPaginatedNested(res, 'messages', messages, {
      total: result.total, limit: result.limit, offset: result.offset, hasMore: result.hasMore,
    });
  }));

  // GET /messages/unread/count — Get unread count
  router.get('/unread/count', meter, ...protect, requirePermission('messages:read'), withRoute(async ({ res, ctx, orgId }) => {
    ctx.log('INFO', 'Fetching unread count', { orgId });

    const count = await messageService.getUnreadCount(orgId);

    // Parity with every other read handler — the frontend polls this frequently,
    // so omitting the increment systematically under-counts apiCalls.

    ctx.log('COMPLETED', 'Unread count fetched', { count });

    return sendSuccess(res, 200, { count });
  }));

  // GET /messages/deleted — org's soft-deleted message tombstones (most recent
  // first), powering the "recently deleted" restore UI. Registered BEFORE `/:id`
  // so the literal path isn't swallowed by the id matcher.
  router.get('/deleted', meter, ...protect, requirePermission('messages:read'), withRoute(async ({ req, res, ctx, orgId }) => {
    const { limit, offset } = parsePaginationParams(req.query);
    const deleted = await messageService.findDeleted(orgId, { limit, offset });

    ctx.log('COMPLETED', 'Listed deleted messages', { count: deleted.length });

    const messages = await enrichWithOrgNames(deleted);
    return sendSuccess(res, 200, { messages });
  }));

  // GET /messages/recipients/orgs — every org in the caller's account (root +
  // teams, own org included) the compose picker may offer, as
  // `{ orgs: [{ orgId, name, isTeam }] }`. Derived from the same root resolution
  // as the create route's cross-tenant send gate, so it never lists an org that
  // gate would refuse. Gated on `messages:write` — the authority sending needs;
  // a read-only member has nothing to compose. Registered before `/:id`.
  router.get('/recipients/orgs', meter, ...protect, requirePermission('messages:write'), withRoute(async ({ res, ctx, orgId }) => {
    const orgs = await listReachableOrgs(orgId);
    ctx.log('COMPLETED', 'Listed reachable recipient orgs', { count: orgs.length });
    return sendSuccess(res, 200, { orgs });
  }));

  // GET /messages/:id — Get single message
  /**
   * The org's own support cases — the workflow half of its support threads.
   *
   * Mounted ABOVE `/:id` deliberately: Express matches in order, so a later
   * mount would have `support` swallowed as a message id and answer 404 for
   * every caller.
   *
   * Scoped by RLS rather than by a predicate here: `support_cases` is org-scoped
   * and `withTenantTx` sets the tenant GUC, so a tenant physically cannot read
   * another's rows. The staff queue is a different read entirely (no org
   * predicate, sysadmin scope) and does not live on this route.
   *
   * Returns the case fields a tenant may see. `assignedTo` is deliberately
   * ABSENT: which engineer holds a case is internal, and the tenant's
   * counterparty is the support desk, not a named individual.
   */
  router.get('/support/cases', meter, ...protect, requirePermission('messages:read'), withRoute(async ({ res, ctx, orgId }) => {
    const cases = await listOrgCases(orgId);
    ctx.log('COMPLETED', 'Support cases listed', { count: cases.length });
    return sendSuccess(res, 200, {
      cases: cases.map((c) => ({
        threadId: c.threadId,
        displayNumber: c.displayNumber,
        status: c.status,
        severity: c.severity,
        level: c.level,
        openedWithIncident: c.openedWithIncident,
        tenantContact: c.tenantContact,
        firstResponseAt: c.firstResponseAt,
        createdAt: c.createdAt,
        closedAt: c.closedAt,
        // So the tenant page knows whether to offer the rating control or show
        // the score already given. Null is the usual state and stays
        // distinguishable from a low score.
        satisfaction: c.satisfaction,
      })),
    });
  }));

  /**
   * The org's own cases as CSV.
   *
   * Mounted BEFORE the contacts and `:id` routes for the usual reason: Express
   * matches in declaration order, so a later `/support/:id` would swallow
   * `cases/export`.
   *
   * `messages:read`, the SAME floor as the JSON list above, and that is a
   * deliberate departure from the `logs:export` precedent rather than an
   * oversight. `logs:export` was split out of `observability:read` because
   * reading logs in the UI is paged and ephemeral while exporting them is bulk
   * egress that can carry secrets out of the building. Neither applies here:
   * this is the org's OWN support metadata, already fully readable one route
   * up, and reshaping readable data into a file is not a new disclosure.
   *
   * METADATA ONLY — no message bodies. The conversation is the tenant's
   * correspondence with us and exporting it is a different and much larger
   * thing; this is the case ledger (numbers, status, the target each case was
   * opened against), which is what somebody reconciling support against an
   * invoice actually needs.
   */
  router.get('/support/cases/export', meter, ...protect, requirePermission('messages:read'), withRoute(async ({ res, ctx, orgId }) => {
    const cases = await listOrgCases(orgId, EXPORT_MAX);
    const header = [
      'case_number', 'status', 'severity', 'level', 'response_due_at',
      'first_response_at', 'created_at', 'closed_at', 'opened_with_incident',
    ];
    // Hand-rolled rather than a CSV dependency: every field below is a number,
    // an enum or an ISO timestamp, so the only quoting risk is the delimiter
    // itself and `csvCell` covers it. A dependency would be more surface than
    // the problem.
    const rows = cases.map((c) => [
      c.displayNumber,
      c.status,
      c.severity,
      c.level,
      c.responseDueAt?.toISOString() ?? '',
      c.firstResponseAt?.toISOString() ?? '',
      c.createdAt.toISOString(),
      c.closedAt?.toISOString() ?? '',
      c.openedWithIncident ? 'yes' : 'no',
    ].map(csvCell).join(','));
    const body = [header.join(','), ...rows].join('\n');

    ctx.log('COMPLETED', 'Support cases exported', { count: cases.length });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="support-cases.csv"');
    // Sent raw, not through sendSuccess: the caller asked for a file, and
    // wrapping CSV in the JSON envelope would make it unusable as one.
    res.status(200).send(body);
    return undefined;
  }));

  /**
   * The org's own designated support contacts — the candidate list for the
   * transfer picker.
   *
   * Scoped to THIS org, never the account subtree. The contact allowance pools
   * subtree-wide, but ownership does not: offering a sibling team's contact here
   * would make the picker the cross-team case leak the own-org rule exists to
   * prevent. The server rejects such a target anyway, so a wider list would only
   * offer choices that fail.
   *
   * Returns user ids only. Resolving them to names is the caller's job through
   * the member surfaces it already has — shipping an address book from the
   * message service would widen what this route discloses for no gain.
   */
  router.get('/support/contacts', meter, ...protect, requirePermission('messages:read'), withRoute(async ({ res, ctx, orgId }) => {
    const contacts = await listActiveSupportContacts([orgId]);
    ctx.log('COMPLETED', 'Support contacts listed', { count: contacts.length });
    return sendSuccess(res, 200, { contacts: contacts.map((c) => ({ userId: c.userId })) });
  }));

  /**
   * THE STAFF QUEUE: every open case across ALL tenants, oldest first.
   *
   * The one support read with no org predicate, which is exactly why it is
   * gated on `requireSystemAdmin` rather than a permission: `messages:read` is
   * held by ordinary members in every tenant, and this answer spans all of them.
   * A permission gate here would be a cross-tenant leak wearing a gate.
   *
   * The gate is MIDDLEWARE, not a check inside the handler, so it appears in the
   * generated route table — an in-handler check is invisible to the coverage
   * contract, which is how an ungated cross-tenant route would slip through.
   *
   * RESPONSE AGE, not arrival age. `support_case_queue_idx` orders by
   * `created_at`, but a case we answered in an hour where the tenant took four
   * days to reply is not a four-day case. So `waitingSeconds` subtracts
   * `awaitingTotalSeconds`, and the queue is re-sorted on it — the index gets
   * the rows cheaply, this computes the number a human should act on.
   *
   * `firstResponseAt` is included so the queue distinguishes "never answered"
   * from "answered and waiting again", which look identical by age alone and
   * mean opposite things about whether we are late.
   */
  router.get('/support/queue', meter, ...protect, requireSystemAdmin as RequestHandler, withRoute(async ({ res, ctx }) => {
    const cases = await listQueue();
    const now = Date.now();
    const rows = cases.map((c) => {
      const elapsed = Math.max(0, (now - new Date(c.createdAt).getTime()) / 1000);
      return {
        threadId: c.threadId,
        orgId: c.orgId,
        displayNumber: c.displayNumber,
        status: c.status,
        severity: c.severity,
        // The level FROZEN at open — what triage needs to know who is paying,
        // and what target applies to THIS case rather than to the org today.
        level: c.level,
        openedWithIncident: c.openedWithIncident,
        assignedTo: c.assignedTo,
        tenantContact: c.tenantContact,
        firstResponseAt: c.firstResponseAt,
        createdAt: c.createdAt,
        waitingSeconds: Math.round(Math.max(0, elapsed - (c.awaitingTotalSeconds ?? 0))),
      };
    }).sort((a, b) => b.waitingSeconds - a.waitingSeconds);
    ctx.log('COMPLETED', 'Support queue listed', { count: rows.length });
    return sendSuccess(res, 200, { cases: rows });
  }));

  router.get('/:id', meter, ...protect, requirePermission('messages:read'), withRoute(async ({ req, res, orgId }) => {
    const id = getParam(req.params, 'id');

    if (!id) return sendBadRequest(res, 'Message ID is required', ErrorCode.MISSING_REQUIRED_FIELD);

    // Viewer-scoped: a per-user targeted message is returned only to its target
    // (plus the sender org / system org), never to other members of the org.
    const message = await messageService.findVisibleById(id, orgId);
    if (!message) {
      return sendEntityNotFound(res, 'Message');
    }


    return sendSuccess(res, 200, { message: await enrichOneWithOrgNames(message) });
  }));

  // GET /messages/:id/thread — Get thread messages
  router.get('/:id/thread', meter, ...protect, requirePermission('messages:read'), withRoute(async ({ req, res, ctx, orgId }) => {
    const id = getParam(req.params, 'id');

    if (!id) return sendBadRequest(res, 'Message ID is required', ErrorCode.MISSING_REQUIRED_FIELD);

    ctx.log('INFO', 'Fetching thread', { threadId: id });

    // Get the root message first (viewer-scoped: a per-user targeted root is
    // only visible to its target, so the thread stays private to them).
    const rootMessage = await messageService.findVisibleById(id, orgId);
    if (!rootMessage) {
      return sendEntityNotFound(res, 'Thread');
    }

    // Get all replies in the thread (same viewer scope as the root).
    const replies = await messageService.findThreadMessages(id, orgId);

    // Combine root + replies, sorted by creation date
    const thread = [rootMessage, ...replies].sort(
      (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
    );

    // Embed each message's attachment metadata (one batched query for the whole
    // thread) so the client renders attachments without an N+1 fetch-per-message.
    // Authorized already: the caller passed the viewer-scoped root/reply gates.
    const attRows = await attachmentService.findByMessageIds(thread.map((m) => m.id));
    const byMsg = new Map<string, Array<{ id: string; filename: string; contentType: string; sizeBytes: number }>>();
    for (const a of attRows) {
      if (!a.messageId) continue;
      const list = byMsg.get(a.messageId) ?? [];
      list.push({ id: a.id, filename: a.filename, contentType: a.contentType, sizeBytes: a.sizeBytes });
      byMsg.set(a.messageId, list);
    }
    const withAttachments = thread.map((m) => ({ ...m, attachments: byMsg.get(m.id) ?? [] }));
    // Label each row with the counterparty org's name (preserves attachments).
    const messages = await enrichWithOrgNames(withAttachments);

    ctx.log('COMPLETED', 'Thread fetched', { count: thread.length });

    return sendSuccess(res, 200, { messages });
  }));

  // GET /messages/:id/attachments — list a message's attachment metadata. Gated
  // on the SAME viewer-scoped visibility as the message itself: a per-user
  // targeted message's attachment list is only visible to its target.
  router.get('/:id/attachments', meter, ...protect, requirePermission('messages:read'), withRoute(async ({ req, res, orgId }) => {
    const id = getParam(req.params, 'id');
    if (!id) return sendBadRequest(res, 'Message ID is required', ErrorCode.MISSING_REQUIRED_FIELD);

    const message = await messageService.findVisibleById(id, orgId);
    if (!message) return sendEntityNotFound(res, 'Message');

    const rows = await attachmentService.findByMessageId(id);
    const attachments = rows.map((a) => ({
      id: a.id,
      filename: a.filename,
      contentType: a.contentType,
      sizeBytes: a.sizeBytes,
    }));

    return sendSuccess(res, 200, { attachments });
  }));

  return router;
}
