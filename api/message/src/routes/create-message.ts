// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import {
  SYSTEM_ORG_ID,
  sendError,
  sendBadRequest,
  sendSuccess,
  ErrorCode,
  getParam,
  getPrimarySupportAlias,
  isSystemAdmin,
  isServicePrincipal,
  requirePermission,
  validateBody,
  MessageCreateSchema,
  MessageReplySchema,
  audited,
  resolveRecipientAlias,
  sendEntityNotFound,
  errorMessage,
  actorId,
  admitCaseSeverity,
  envInt,
  recordAudit,
  responseDueAt,
} from '@pipeline-builder/api-core';
import { withRoute, createAuthenticatedWithOrgRoute, incCounter, observe, rateLimitByOrg } from '@pipeline-builder/api-server';
import type { RequestContext, SSEManager } from '@pipeline-builder/api-server';
import { schema, countCasesInWindow, openSupportCase, findCaseByThread, isPremiumSupportContact, stampFirstResponse } from '@pipeline-builder/pipeline-data';
import { consumeSupportIncident, refundSupportIncident } from '../services/support-incident-client.js';
import { Router } from 'express';
import type { Response } from 'express';
import { notifyNewMessage, validateRecipient } from '../helpers/new-message.js';
import type { NewMessageNotification } from '../helpers/new-message.js';
import { enrichOneWithOrgNames } from '../helpers/org-names.js';
import { isRecipientReachable, isTargetUserReachable } from '../helpers/org-reachability.js';
import { attachmentService } from '../services/attachment-service.js';
import { fetchSupportEntitlement } from '../services/support-entitlement-client.js';
import { messageService } from '../services/message-service.js';

type MessageInsert = typeof schema.message.$inferInsert;

/** Reserved channel every support-contact message is filed under, so system-org
 *  readers can filter the support desk out of the rest of their inbox. */
const SUPPORT_CHANNEL = 'support';
/** Per-org send limiter — a single org can't flood messages/replies (each one
 *  fans out over SSE + writes rows). Shared across send + reply. Env-overridable.
 *  Verified service principals are exempt; unauthenticated falls back to per-IP. */
const sendLimiter = rateLimitByOrg({
  name: 'message-send',
  max: envInt('MESSAGE_SEND_RATE_MAX', 60, { min: 1 }),
  windowMs: envInt('MESSAGE_SEND_RATE_WINDOW_MS', 60000, { min: 1000 }),
  message: 'Too many messages sent, please slow down.',
});

/** Everything the shared persist tail needs beyond the row itself. */
interface PersistOptions {
  /** The row to insert. */
  data: MessageInsert;
  /** Tenant + author, used for the attachment-link ownership check. */
  orgId: string;
  userId: string;
  /** Pre-uploaded attachment ids the client asked to attach, if any. */
  attachmentIds?: string[];
  /** WARN line when fewer attachments linked than were requested. */
  partialAttachmentWarning: string;
  /** COMPLETED log line + its structured fields (`id` is added here). */
  completed: { label: string; details?: Record<string, unknown> };
  /** SSE payload, minus `messageId` — only known after the insert. */
  notification: Omit<NewMessageNotification, 'messageId'>;
  /** Runs once the row is durable and the ping is out, before the 201 is
   *  written. POST / uses it to emit the announcement audit event. */
  onPersisted?: (messageId: string) => void;
  /** Human-readable text on the 201. */
  successMessage: string;
}

/**
 * The tail every send route shares: insert the row, link the caller's
 * pre-uploaded attachments, log COMPLETED, count the domain metric, push the
 * real-time NEW_MESSAGE ping, and answer 201 with the org-name-enriched row.
 *
 * Extracted because it was written out three times (send / support / reply)
 * and every copy had to remember the SAME two easily-forgotten steps — the
 * `message_events_total` counter and the SSE notify. A fourth send route that
 * skipped either would leave the metric silently under-counting and the
 * recipient's inbox not refreshing, with nothing failing to say so.
 *
 * Attachment linking is deliberately non-fatal: only the caller's own
 * still-pending uploads link (enforced in the service), so a mismatch means the
 * client sent a bogus / foreign / already-linked id. The message stands with
 * whatever validly linked, and the shortfall is logged.
 */
async function persistAndRespond(
  sseManager: SSEManager,
  ctx: RequestContext,
  res: Response,
  opts: PersistOptions,
): Promise<void> {
  const message = await messageService.create(opts.data, opts.userId);

  if (opts.attachmentIds?.length) {
    const linked = await attachmentService.linkToMessage(opts.attachmentIds, message.id, opts.orgId, opts.userId);
    if (linked.length !== opts.attachmentIds.length) {
      ctx.log('WARN', opts.partialAttachmentWarning, { requested: opts.attachmentIds.length, linked: linked.length });
    }
  }

  ctx.log('COMPLETED', opts.completed.label, { id: message.id, ...opts.completed.details });

  // Domain metric — a message row was created. Tagged by action only to keep
  // label cardinality bounded (no orgId/messageId).
  incCounter('message_events_total', { action: 'created' });

  notifyNewMessage(
    sseManager,
    { ...opts.notification, messageId: message.id },
    (err) => ctx.log('WARN', 'Failed to send SSE notification', { error: errorMessage(err) }),
  );

  opts.onPersisted?.(message.id);

  return sendSuccess(res, 201, await enrichOneWithOrgNames(message), opts.successMessage);
}

/**
 * Create the message creation router (authenticated).
 *
 * Registers:
 * - POST /messages           -- create a new announcement or conversation
 * - POST /messages/support   -- contact the support desk (recipient forced)
 * - POST /messages/:id/reply -- reply to an existing thread
 * @param sseManager - SSE manager for pushing real-time notifications
 * @returns Express Router
 */
export function createCreateMessageRoutes(sseManager: SSEManager): Router {
  const router = Router();

  // POST /messages — Create new message. `audited` declares the ONLY action this
  // route emits: a sysadmin org-wide announcement. 1:1 conversations are
  // deliberately not audited (see the emission below).
  router.post('/', ...createAuthenticatedWithOrgRoute(), requirePermission('messages:write'), sendLimiter, audited('message.announcement.create'), withRoute(async ({ req, res, ctx, orgId, userId }) => {
    // Validate request body with Zod schema
    const validation = validateBody(req, MessageCreateSchema);
    if (!validation.ok) {
      return sendBadRequest(res, validation.error, ErrorCode.VALIDATION_ERROR);
    }

    const { recipientOrgId: rawRecipientOrgId, recipientUserId, messageType, subject, content, priority, channel, attachmentIds } = validation.value;

    // Resolve email-like aliases (e.g., support@pipeline-builder -> system)
    const { resolvedOrgId: recipientOrgId, wasAlias, originalValue } = resolveRecipientAlias(rawRecipientOrgId);
    if (wasAlias) {
      ctx.log('INFO', 'Resolved recipient alias', { alias: originalValue, resolvedTo: recipientOrgId });
    }

    // Synchronous recipient-shape rules (announcement authority + '*' broadcast
    // reservation + per-user targeting) — see validateRecipient for each rule.
    const rejection = validateRecipient({
      messageType,
      recipientOrgId,
      recipientUserId,
      isSysadmin: isSystemAdmin(req),
    });
    if (rejection) {
      return rejection.status === 403
        ? sendError(res, 403, rejection.message, rejection.code)
        : sendBadRequest(res, rejection.message, rejection.code);
    }

    // Cross-tenant send gate. A non-sysadmin member may only start a
    // conversation with an org they could also RECEIVE from — mirroring the
    // read-visibility model in `buildMessageConditions`. Reachable recipients:
    //   - the caller's OWN org;
    //   - the SYSTEM support inbox (support channel — always reachable);
    //   - an org within the caller's ACCOUNT (same root org → team hierarchy).
    // Without this, any member could drop an unsolicited message into an
    // arbitrary tenant's inbox (the recipient can read it). Sysadmins and
    // service principals (support-replies-out, internal automation) may target
    // any org and bypass the gate. Announcements are '*' broadcasts already
    // gated to sysadmins above, so they never reach here as a concrete org.
    if (
      messageType === 'conversation'
      && !isSystemAdmin(req)
      && !isServicePrincipal(req)
      && !(await isRecipientReachable(orgId, recipientOrgId))
    ) {
      ctx.log('WARN', 'Blocked cross-tenant message recipient', { recipientOrgId });
      return sendError(
        res,
        403,
        'You cannot send a message to that organization',
        ErrorCode.INSUFFICIENT_PERMISSIONS,
      );
    }

    // Per-user target must be an ACTIVE member of the recipient org, else the DM
    // black-holes (viewer-scoping surfaces it to that user alone; a non-member
    // is nobody). Reject the mistake up front. Fail-open on an indeterminate
    // platform lookup — this is a correctness guard, not an authz boundary
    // (the recipient still can't read anything they're not scoped for).
    if (recipientUserId && !(await isTargetUserReachable(recipientOrgId, recipientUserId))) {
      ctx.log('WARN', 'Blocked DM to non-member recipient user', { recipientOrgId });
      return sendBadRequest(res, 'recipientUserId is not an active member of the recipient organization', ErrorCode.VALIDATION_ERROR);
    }

    ctx.log('INFO', 'Creating message', { messageType, recipientOrgId, subject });

    const messageData: MessageInsert = {
      orgId,
      recipientOrgId: recipientOrgId.toLowerCase() === '*' ? '*' : recipientOrgId.toLowerCase(),
      // Per-user target (null = whole recipient org). Guarded above to be absent
      // on announcements / '*' broadcasts.
      recipientUserId: recipientUserId ?? null,
      messageType,
      channel: channel?.toLowerCase() ?? null,
      subject,
      content,
      priority,
      createdBy: userId,
      updatedBy: userId,
    };

    return persistAndRespond(sseManager, ctx, res, {
      data: messageData,
      orgId,
      userId,
      attachmentIds,
      partialAttachmentWarning: 'Some attachments did not link',
      completed: { label: 'Message created', details: { messageType } },
      notification: {
        recipientOrgId,
        subject,
        targeted: !!recipientUserId,
        senderOrgId: orgId,
        messageType,
      },
      // Audit ONLY admin broadcasts. Announcements are sysadmin org-wide
      // broadcasts (gated above to messageType==='announcement' + recipient '*');
      // 1:1 conversations/replies are intentionally NOT audited — they are noisy
      // and would pull private message content into the trail. `details` carries
      // SAFE METADATA ONLY (subject/type/recipient scope) — never the body.
      // Fire-and-forget: emission never throws and is not awaited.
      onPersisted: (messageId) => {
        if (messageType !== 'announcement') return;
        recordAudit({
          action: 'message.announcement.create',
          actorId: actorId({ userId }),
          orgId,
          targetId: messageId,
          details: {
            subject,
            messageType,
            recipientScope: 'org-wide',
          },
        });
      },
      successMessage: 'Message created successfully',
    });
  }));

  // POST /messages/support — Contact the support desk.
  //
  // Reaching support is SELF-SERVICE: every member who can open the messages
  // page must be able to file a request, including a read-only member who holds
  // no `messages:write` and therefore cannot use POST / (whose write gate stays
  // correct for ordinary org-to-org sends). So the floor here is the same
  // `messages:read` the inbox itself requires — and it rides the ROUTE, not the
  // handler, so the generated route table advertises it truthfully. Plain
  // `requirePermission`, never `requirePermissionOrService`: a service principal
  // has no support request of its own to file (support-replies-out go back
  // through POST /, where a service token may target any org).
  //
  // Shares the send limiter with POST / and POST /:id/reply — one org can't
  // flood the desk by switching routes.
  //
  // Deliberately NOT audited, exactly like the 1:1 conversation POST / creates:
  // only admin broadcasts and the destructive delete/restore/purge reach the
  // central trail (see the `audited` note on POST / and the route-coverage
  // exception that records this).
  router.post('/support', ...createAuthenticatedWithOrgRoute(), requirePermission('messages:read'), sendLimiter, withRoute(async ({ req, res, ctx, orgId, userId }) => {
    // The recipient is NOT a client input on this route. Whatever the body
    // carried for recipientOrgId / recipientUserId / messageType / channel is
    // OVERWRITTEN here, before validation — a forged recipient is discarded,
    // never honoured and never an error the caller can probe. Everything else
    // (subject / content / priority / attachmentIds) goes through the SAME
    // MessageCreateSchema the ordinary send validates against.
    const supportAlias = getPrimarySupportAlias();
    req.body = {
      ...(req.body as Record<string, unknown> | undefined),
      recipientOrgId: supportAlias,
      recipientUserId: undefined,
      messageType: 'conversation' as const,
      channel: SUPPORT_CHANNEL,
    };

    const validation = validateBody(req, MessageCreateSchema);
    if (!validation.ok) {
      return sendBadRequest(res, validation.error, ErrorCode.VALIDATION_ERROR);
    }

    // Read back ONLY the caller-owned fields; the recipient is re-derived from
    // the forced alias below rather than from the validated body, so no schema
    // change can ever let a client value decide where this lands.
    const { subject, content, priority, attachmentIds } = validation.value;

    // Same alias resolution the ordinary send uses (support@… → system org).
    // When SUPPORT_ALIASES is unconfigured the primary alias is the well-known
    // fallback, which resolves to itself — the support desk is the system org
    // either way, so fall back to it explicitly rather than addressing a
    // nonexistent org named after the alias.
    const { resolvedOrgId, wasAlias } = resolveRecipientAlias(supportAlias);
    const recipientOrgId = wasAlias ? resolvedOrgId : SYSTEM_ORG_ID;

    // Same reachability semantics as POST / — the system support inbox is
    // reachable from every org (its fast path needs no lookup). Asserted rather
    // than assumed so that if the support desk ever moves off the system org,
    // this route can't quietly become a cross-tenant send path.
    if (!(await isRecipientReachable(orgId, recipientOrgId))) {
      ctx.log('WARN', 'Support inbox is not reachable', { recipientOrgId });
      return sendError(res, 403, 'You cannot send a message to that organization', ErrorCode.INSUFFICIENT_PERMISSIONS);
    }

    ctx.log('INFO', 'Contacting support', { recipientOrgId, subject });

    // --- Entitlement, read BEFORE the write -----------------------------------
    //
    // Read up here rather than beside the case insert because the answer decides
    // the SEVERITY this message is filed at, and the message and its case must
    // not disagree about that. A message standing at `urgent` over a case the
    // desk holds at `high` would read as the customer having declared an
    // emergency that the trail says they never got.
    //
    // DEGRADED MODE (see the client's module comment): an unavailable
    // entitlement read leaves the message in place and skips the case. Fail
    // closed on the promise, open on reachability — refusing a support message
    // because platform is down denies support exactly when the outage is ours,
    // while creating a case anyway would promise a response target nobody
    // verified was bought and freeze an unknown `level` onto the row.
    const entitlement = await fetchSupportEntitlement(orgId);
    const bySeat = Boolean(entitlement?.canOpenCase && entitlement.level);

    /**
     * THE DISJUNCTION: a contact seat OR a one-time incident.
     *
     * `SupportEntitlement.canOpenCase` has documented this shape all along —
     * "a one-time incident is a separate door" — and for a while only the first
     * half existed. An incident serves the customer who needs one answer and has
     * no support subscription, so it is tried only when there is no seat: an org
     * with contacts must never silently spend a concession it did not need.
     *
     * The consume is ATOMIC and authoritative in billing, so there is no
     * read-then-spend race. It fails CLOSED — unlike every other support read,
     * which fails open on reachability — because spending an incident is a
     * purchase decision rather than a promise: assuming one was available while
     * billing is unreachable opens a case the customer was never entitled to.
     * The MESSAGE lands either way; only the case is withheld.
     */
    const byIncident = !bySeat && Boolean(entitlement) && await consumeSupportIncident(orgId);
    const opening = bySeat || byIncident;

    /**
     * The level this case is actually owed, which is the OPENING CONTACT's and
     * not the account's.
     *
     * Premium is an upgrade applied per contact, so an account holding one
     * upgrade has one person entitled to 24x7 and everybody else on the
     * baseline. Reading the account's level here instead would hand
     * out-of-hours coverage to every contact of a one-upgrade account — the
     * strongest promise in the catalog, given away by the cheapest version of
     * it.
     *
     * Own-org scope: the upgrade follows the person in the org that nominated
     * them, and a sibling team's upgrade is not this org's to spend. Only asked
     * when the account holds the upgrade at all, so the ordinary case costs no
     * extra query.
     */
    const openerIsPremium = bySeat && entitlement!.premium
      // DEGRADES rather than throwing. `fetchSupportEntitlement` is carefully
      // written never to throw, for a reason stated in its own module comment:
      // fail closed on the PROMISE, open on REACHABILITY, because refusing a
      // support message when platform is down denies support exactly when the
      // outage is ours. This read is raw Postgres and sits BEFORE the message
      // write, so without the catch it reintroduced the same failure from the
      // other side — a database hiccup here would 500 a send that the design
      // guarantees always lands.
      //
      // The fallback is `false`, i.e. the account's baseline. Closed on the
      // promise: an upgrade we could not verify is not one we grant.
      ? await isPremiumSupportContact([orgId], userId).catch((err) => {
        ctx.log('WARN', 'Premium-contact lookup failed; opening at the baseline level', { error: errorMessage(err) });
        return false;
      })
      : false;
    /**
     * An incident-opened case has no SOLD level, because the account may hold no
     * support at all — that is the whole point of the door. `support_incident`
     * is a level of its own rather than a borrowed one: `responseTargetLabel`
     * and `SUPPORT_TARGET_MEASURES` both return nothing for an unrecognised
     * level by design, so the case correctly carries NO stated response target.
     * A concession is a promise to answer, not a promise to answer by a time.
     */
    const caseLevel = openerIsPremium
      ? 'support_premium'
      : entitlement?.level ?? (byIncident ? 'support_incident' : null);

    // `urgent` is admitted only at premium, and a lower level asking for it is
    // DOWNGRADED rather than refused — the message always sends. Passing a null
    // level when no case is opening is deliberate: with no commitment to
    // protect, an outage of ours must not quietly demote someone's label.
    const { severity, downgraded } = admitCaseSeverity(
      priority ?? 'normal',
      opening ? caseLevel : null,
    );
    if (downgraded) {
      ctx.log('INFO', 'Urgent severity not admitted at this level', { level: entitlement?.level, severity });
    }

    /**
     * FAIR USE: how many cases this account has raised lately, against what its
     * contact count entitles it to.
     *
     * SOFT BY DESIGN — it never refuses. "We have stopped answering you" is not
     * a sendable message, so crossing the line raises a counter and a WARN and
     * is recorded on the audit row; acting on it is a commercial conversation,
     * not a 403. The check exists because the per-contact unit prices the
     * INTERFACE and not the LOAD: three named contacts routing a hundred
     * people's tickets blow through three contacts' worth of cases, and this is
     * the only thing in the system that notices.
     *
     * Measured against contacts BOUGHT (`limit`), not designated (`used`): an
     * account that paid for five contacts is entitled to five contacts' worth of
     * cases whether or not it has nominated them all.
     *
     * Deliberately NOT severity-weighted. Cost tracks case DURATION, which is
     * not instrumented at all — only first response is — and severity is
     * self-declared. Weighting a self-declared field would be precision theatre:
     * it would read as rigorous while being gameable in both directions, and the
     * honest statement is that this counts cases because count is what can be
     * measured.
     */
    let overAllowance = false;
    if (bySeat && entitlement!.limit > 0) {
      const perContact = envInt('SUPPORT_CASE_ALLOWANCE_PER_CONTACT', 5, { min: 0 });
      const windowDays = envInt('SUPPORT_CASE_ALLOWANCE_WINDOW_DAYS', 30, { min: 1 });
      if (perContact > 0) {
        const allowance = entitlement!.limit * perContact;
        // Own-org scope, matching where the cases live. A subtree count would
        // need the hierarchy, which this service does not have -- and the
        // allowance is a signal rather than a gate, so an under-count here
        // costs nothing but a slightly later warning.
        // Same degradation, and here the fallback is even clearer: the check is
        // ADVISORY. A counter that cannot be read must not be the reason a
        // customer's support request fails, so an error skips the check
        // entirely rather than denying the send or guessing a number. `-1`
        // cannot trip the comparison below.
        const recent = await countCasesInWindow([orgId], windowDays).catch((err) => {
          ctx.log('WARN', 'Fair-use case count unavailable; skipping the check', { error: errorMessage(err) });
          return -1;
        });
        if (recent >= allowance) {
          overAllowance = true;
          incCounter('support_cases_total', { action: 'over_allowance' });
          ctx.log('WARN', 'Support case volume is past fair use', {
            recent, allowance, contacts: entitlement!.limit, windowDays,
          });
        }
      }
    }

    const messageData: MessageInsert = {
      orgId,
      recipientOrgId: recipientOrgId.toLowerCase(),
      // Support is an org→desk conversation: never per-user targeted, never an
      // announcement, and always filed under the support channel.
      recipientUserId: null,
      messageType: 'conversation',
      channel: SUPPORT_CHANNEL,
      subject,
      content,
      // The ADMITTED severity, not the requested one, so the conversation and
      // its case carry the same number.
      priority: severity as typeof priority,
      createdBy: userId,
      updatedBy: userId,
    };

    const message = await messageService.create(messageData, userId);

    // Same attachment linking as POST /: only the caller's own still-pending
    // uploads link (enforced in the service); a mismatch is logged, non-fatal.
    if (attachmentIds?.length) {
      const linked = await attachmentService.linkToMessage(attachmentIds, message.id, orgId, userId);
      if (linked.length !== attachmentIds.length) {
        ctx.log('WARN', 'Some attachments did not link', { requested: attachmentIds.length, linked: linked.length });
      }
    }

    // --- Case record -------------------------------------------------------
    //
    // The message is already committed. A case is the WORKFLOW record on top of
    // it — status, ownership, the response clock — and it is created only when
    // platform confirmed, above, that the org is entitled to one.
    if (opening) {
      try {
        const supportCase = await openSupportCase({
          // The root message IS the case identity — the convention the thread
          // reader already walks.
          threadId: message.id,
          orgId,
          // Frozen at open: a mid-case downgrade must not change the promise
          // underneath someone already waiting.
          level: caseLevel!,
          severity,
          openedBy: userId,
          // Computed HERE and frozen onto the row. The business calendar is
          // deployment config, so the deadline is derived once at open against
          // the calendar in force at that moment — a later change to the working
          // week or the holiday list must not move a promise already made.
          // Premium's own measure consults no calendar at all, which is the whole
          // of its 24x7 claim.
          responseDueAt: responseDueAt(new Date(), caseLevel!),
          // Which DOOR this case came through. The store defaults it to false,
          // so omitting it here meant an incident-opened case recorded itself as
          // seat-opened — the audit row said one thing and the case row another.
          openedWithIncident: byIncident,
        });
        ctx.log('COMPLETED', 'Support case opened', {
          id: message.id, caseNumber: supportCase.displayNumber, level: caseLevel!,
        });
        // Audited because a case carries a response-time commitment: the facts a
        // dispute turns on are who raised it, when, and under which level. Safe
        // METADATA ONLY — never the body of what the customer wrote.
        recordAudit({
          action: 'support.case.open',
          actorId: actorId({ userId }),
          orgId,
          affectedOrgId: orgId,
          targetType: 'support_case',
          // The thread root id IS the case identity, so the trail and the
          // product agree on what "this case" means.
          targetId: message.id,
          details: {
            caseNumber: supportCase.displayNumber,
            // The CONTACT's level, plus the account baseline it was resolved
            // against, so the trail shows both what was promised and why.
            level: caseLevel!,
            accountLevel: entitlement!.level!,
            openerIsPremium,
            // The ADMITTED severity, plus whether it was cut down. A dispute
            // over "we said urgent" turns on exactly this pair.
            severity,
            severityRequested: priority ?? 'normal',
            // Recorded so a later fair-use conversation has the case list behind
            // it rather than a single aggregate number.
            overAllowance,
            // Whether this case came through the INCIDENT door rather than a
            // contact seat, so incident usage is answerable from the cases
            // themselves and not only from a balance delta.
            openedWithIncident: byIncident,
          },
        });
        incCounter('support_cases_total', { action: byIncident ? 'opened_with_incident' : 'opened' });
      } catch (err) {
        // The message stands. A failed case insert must not 500 a send that
        // already succeeded — the tenant would retry and file a duplicate.
        ctx.log('ERROR', 'Support case insert failed; message kept without a case', { id: message.id, error: errorMessage(err) });
        incCounter('support_cases_total', { action: 'open_failed' });
        // GIVE THE INCIDENT BACK. It was already spent to get here, and losing a
        // concession to our own failed insert is the worst possible way to spend
        // one — the customer paid nothing for it and received nothing. Awaited
        // so the refund is attempted before the response, and itself
        // never-throwing, because failing the send to report a failed refund
        // turns one problem into two.
        if (byIncident) await refundSupportIncident(orgId);
      }
    } else if (entitlement && !entitlement.canOpenCase && !byIncident) {
      // Entitlement was READ and says no: the org has no designated contact in
      // THIS org (the allowance pools subtree-wide, ownership does not). Not an
      // error — the message is support correspondence, it just carries no
      // response target.
      ctx.log('INFO', 'No support entitlement for this org; message sent without a case', {
        id: message.id, ownOrgContacts: entitlement.ownOrgContacts, limit: entitlement.limit,
      });
      incCounter('support_cases_total', { action: 'unentitled' });
    }

    // Not an error count — a DEMAND count. Every increment is an org that
    // wanted the one thing only premium admits, which is the most direct read on
    // premium's addressable demand the system can produce.
    if (downgraded) incCounter('support_cases_total', { action: 'severity_downgraded' });

    ctx.log('COMPLETED', 'Support message created', { id: message.id });

    incCounter('message_events_total', { action: 'created' });

    notifyNewMessage(sseManager, {
      recipientOrgId,
      messageId: message.id,
      subject,
      targeted: false,
      senderOrgId: orgId,
      messageType: 'conversation',
    }, (err) => ctx.log('WARN', 'Failed to send SSE notification', { error: errorMessage(err) }));

    // Say it plainly when the severity was cut down. The payload already carries
    // the admitted `priority`, but a sender who typed "urgent" and hears nothing
    // will reasonably believe it was honoured — and that belief is exactly what
    // a response-time dispute is made of.
    return sendSuccess(
      res,
      201,
      await enrichOneWithOrgNames(message),
      downgraded
        ? 'Message created. Urgent severity is available on Premium Support; this case was opened as high.'
        : 'Message created successfully',
    );
  }));

  // POST /messages/:id/reply — Reply to a thread
  /**
   * The reply handler, built once and mounted twice.
   *
   * `supportScoped` is the SECOND mount: `POST /messages/support/:id/reply`,
   * gated on `messages:read` instead of `messages:write`. That carve-out exists
   * because the person who raised a support case usually holds read and not
   * write — `POST /messages/support` is already gated that way for exactly this
   * reason, so without it the people the support form is built for could open a
   * request and then be unable to answer the reply.
   *
   * Sharing the body rather than copying it: the thread-root invariant, the
   * participant check, the private-thread targeting and the first-response
   * measurement are all load-bearing, and a second copy would drift from this
   * one on the next change to either.
   */
  const makeReplyHandler = (supportScoped: boolean) => withRoute(async ({ req, res, ctx, orgId, userId }) => {
    const id = getParam(req.params, 'id');

    if (!id) return sendBadRequest(res, 'Message ID is required', ErrorCode.MISSING_REQUIRED_FIELD);

    // Validate request body with Zod schema
    const validation = validateBody(req, MessageReplySchema);
    if (!validation.ok) {
      return sendBadRequest(res, validation.error, ErrorCode.VALIDATION_ERROR);
    }

    const { content, attachmentIds } = validation.value;

    // Find the root message, VIEWER-SCOPED: if the root is targeted at a specific
    // user, only that user (and the sender org / system org) can load it — so a
    // non-target member of the recipient org can't reply into a private thread.
    const rootMessage = await messageService.findVisibleById(id, orgId);
    if (!rootMessage) {
      return sendEntityNotFound(res, 'Message');
    }

    // Thread-root invariant: the target must be a root message (not itself a
    // reply). Allowing replies-to-replies creates orphan grandchildren — the
    // thread reader walks `threadId === root.id`, so a deeper hierarchy is
    // invisible from the UI. Force the client to reply to the root.
    if (rootMessage.threadId) {
      return sendBadRequest(
        res,
        'Cannot reply to a reply. Reply to the root message of the thread instead.',
        ErrorCode.VALIDATION_ERROR,
      );
    }

    // Validate the user can reply (must be sender org, recipient org, or system org)
    const isSender = rootMessage.orgId.toLowerCase() === orgId;
    const isRecipient = rootMessage.recipientOrgId.toLowerCase() === orgId;
    const isBroadcast = rootMessage.recipientOrgId === '*';
    const isSystem = orgId === SYSTEM_ORG_ID;

    if (!isSender && !isRecipient && !isBroadcast && !isSystem) {
      return sendError(res, 403, 'You are not a participant in this conversation', ErrorCode.INSUFFICIENT_PERMISSIONS);
    }

    // The support carve-out's own gate. This mount runs on `messages:read`, so
    // the participant check above is not sufficient on its own — org-wide
    // visibility means ANY reader in the sender org passes it, and replying on a
    // case is a narrower right than reading one.
    //
    // Admitted: the case's AUTHOR, and its current `tenant_contact`. The second
    // is not optional — tenant-side reassignment exists so a case can change
    // hands when its opener goes on leave, and if the new owner cannot reply the
    // reassignment is cosmetic.
    //
    // Deliberately NOT "any designated contact": that needs the cross-service
    // entitlement read on every reply, adding latency and a second degraded-mode
    // question to a path whose answer is already on rows this service holds.
    if (supportScoped) {
      if (rootMessage.channel?.toLowerCase() !== SUPPORT_CHANNEL) {
        return sendBadRequest(res, 'That thread is not a support case', ErrorCode.VALIDATION_ERROR);
      }
      // Staff reply through the ordinary route; this door is for the tenant side.
      if (!isSystem) {
        const supportCase = await findCaseByThread(id);
        const isAuthor = rootMessage.createdBy === userId;
        const isOwner = supportCase?.tenantContact === userId;
        if (!isAuthor && !isOwner) {
          return sendError(
            res,
            403,
            'Only the person who raised this case, or the contact it is assigned to, can reply to it',
            ErrorCode.INSUFFICIENT_PERMISSIONS,
          );
        }
      }
    }

    ctx.log('INFO', 'Replying to thread', { threadId: id });

    // Determine the recipient for the reply
    let replyRecipientOrgId: string;
    if (isSystem) {
      // System org replying — send to the original sender
      replyRecipientOrgId = rootMessage.orgId;
    } else if (isBroadcast) {
      // Replying to announcement — send to the system org
      replyRecipientOrgId = SYSTEM_ORG_ID;
    } else {
      // Regular org replying — send to the other party
      replyRecipientOrgId = isSender ? rootMessage.recipientOrgId : rootMessage.orgId;
    }

    // A reply is ALWAYS a conversation, never an announcement — even when the
    // root is an announcement (a member replying to a broadcast opens a 1:1
    // support thread to the system org). Copying rootMessage.messageType here
    // persisted `announcement`-typed rows authored by non-sysadmins, polluting
    // messageType filters and the announcements feed. Pin replies to conversation.
    const replyMessageType = 'conversation' as const;

    // Keep a per-user targeted thread private: when the reply is addressed BACK
    // to the org that held the targeted user (rootMessage.recipientOrgId), carry
    // the target forward so only that user sees it. Replies toward the sender org
    // stay org-wide (the sender side was always org-wide). Null-safe: an untargeted
    // root yields null on both branches (today's behavior).
    const replyRecipientUserId =
      replyRecipientOrgId.toLowerCase() === rootMessage.recipientOrgId.toLowerCase()
        ? rootMessage.recipientUserId ?? null
        : null;

    const replyData: MessageInsert = {
      orgId,
      threadId: id,
      recipientOrgId: replyRecipientOrgId,
      recipientUserId: replyRecipientUserId,
      messageType: replyMessageType,
      // Replies inherit the root message's channel so the thread stays
      // in one bucket — system-org filtering by channel sees the whole
      // conversation, not just the first message.
      channel: rootMessage.channel?.toLowerCase() ?? null,
      subject: rootMessage.subject,
      content,
      priority: rootMessage.priority,
      createdBy: userId,
      updatedBy: userId,
    };

    const reply = await messageService.create(replyData, userId);

    // --- The measured number -----------------------------------------------
    //
    // First response is what the response target is SOLD on, so it is stamped
    // here — the moment staff first answer — rather than derived later from
    // message timestamps, which would have to re-infer "was that reply from
    // staff" on every read.
    //
    // `isSystem` is the staff test: a tenant replying to its own case is not a
    // response to it. `stampFirstResponse` carries `first_response_at IS NULL`
    // in its WHERE clause, so a second staff reply cannot move the number — the
    // guard is in the UPDATE, not in a caller's check.
    if (isSystem && rootMessage.channel?.toLowerCase() === SUPPORT_CHANNEL) {
      try {
        const supportCase = await findCaseByThread(id);
        const stamped = supportCase ? await stampFirstResponse(supportCase.id) : false;
        if (supportCase && stamped) {
          // Elapsed WALL time minus time spent waiting on the customer, which is
          // the only version of this number a customer would accept: a case we
          // answered in an hour, where the tenant took four days to reply, is
          // not a four-day first response.
          const waited = Math.max(0, (Date.now() - new Date(supportCase.createdAt).getTime()) / 1000);
          const paused = supportCase.awaitingTotalSeconds ?? 0;
          observe('support_first_response_seconds', { level: supportCase.level, severity: supportCase.severity }, Math.max(0, waited - paused));
          incCounter('support_cases_total', { action: 'first_response' });
        }
        // Audited on the STAFF side only. A tenant replying to its own case is
        // ordinary correspondence; a vendor reply is the act the response target
        // is measured against, and `firstResponse` records whether THIS reply
        // was the one that stopped the clock.
        recordAudit({
          action: 'support.case.reply',
          actorId: actorId({ userId }),
          orgId,
          affectedOrgId: rootMessage.orgId,
          targetType: 'support_case',
          targetId: id,
          details: { firstResponse: stamped },
        });
        incCounter('support_cases_total', { action: 'staff_replied' });
      } catch (err) {
        // The reply is committed. Losing the measurement is bad; rejecting a
        // staff reply because the measurement failed is worse.
        ctx.log('WARN', 'Support first-response stamp failed', { threadId: id, error: errorMessage(err) });
        incCounter('support_cases_total', { action: 'first_response_failed' });
      }
    }

    if (attachmentIds?.length) {
      const linked = await attachmentService.linkToMessage(attachmentIds, reply.id, orgId, userId);
      if (linked.length !== attachmentIds.length) {
        ctx.log('WARN', 'Some reply attachments did not link', { requested: attachmentIds.length, linked: linked.length });
      }
    }

    ctx.log('COMPLETED', 'Reply created', { id: reply.id, threadId: id });

    // Domain metric — a reply is a created message row too.
    incCounter('message_events_total', { action: 'created' });

    notifyNewMessage(sseManager, {
      recipientOrgId: replyRecipientOrgId,
      messageId: reply.id,
      threadId: id,
      subject: rootMessage.subject,
      targeted: !!replyRecipientUserId,
      senderOrgId: orgId,
      messageType: replyMessageType,
    }, (err) => ctx.log('WARN', 'Failed to send SSE notification', { error: errorMessage(err) }));

    return sendSuccess(res, 201, await enrichOneWithOrgNames(reply), 'Reply sent successfully');
  });

  // The ordinary reply: any participant holding `messages:write`.
  router.post('/:id/reply', ...createAuthenticatedWithOrgRoute(), requirePermission('messages:write'), sendLimiter, makeReplyHandler(false));

  /**
   * The SUPPORT reply, gated on `messages:read`.
   *
   * Mounted ABOVE nothing in particular but kept distinct from `/:id/reply` so
   * the permission floors stay separate and visible. The handler applies the
   * extra eligibility check (support channel, and caller is the case's author or
   * its current tenant contact) — a write holder has the route above and does
   * not need this one, so it deliberately does NOT widen reply rights for
   * anybody who already had them.
   */
  router.post('/support/:id/reply', ...createAuthenticatedWithOrgRoute(), requirePermission('messages:read'), sendLimiter, makeReplyHandler(true));

  return router;
}
