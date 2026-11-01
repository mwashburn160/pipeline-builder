// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The support-case WORKFLOW routes: status, severity, and the two owners.
 *
 * Separate from the message routes because these mutate the case record rather
 * than the conversation, and because their permission floors differ from
 * `messages:*` in ways that matter:
 *
 *  - **Status** is both-sided, with ONE asymmetry: either side may CLOSE a case,
 *    but only staff may REOPEN a closed one. A tenant closing its own case is
 *    the point of having a status at all, and staff need it to park a case on
 *    the customer. So it runs on `messages:read` with a participant check, like
 *    the reply carve-out. See `TENANT_TERMINAL_STATUSES` for why the reopen is
 *    carved out — it is a product rule and a commercial one at once.
 *  - **Severity re-ranking is STAFF ONLY.** The tenant sets severity at open;
 *    if they could also change it afterwards they would unilaterally choose the
 *    response target they are owed, which at $99.99/contact is the whole premium
 *    SKU. This is the governance half of scope C2.
 *  - **Assign is staff only** — `assigned_to` is a system-org actor.
 *  - **Transfer is tenant only** — handing a case to another designated contact
 *    of the same org.
 *
 * Every one of them is audited. Each moves a case's relationship to its
 * response commitment: status stops or restarts the clock, severity changes
 * which target applies, and ownership decides who is accountable for meeting
 * it.
 */

import {
  ErrorCode,
  SYSTEM_ORG_ID,
  actorId,
  audited,
  getParam,
  isSystemAdmin,
  recordAudit,
  requirePermission,
  requireSystemAdmin,
  sendBadRequest,
  sendError,
  sendSuccess,
} from '@pipeline-builder/api-core';
import { createAuthenticatedWithOrgRoute, observe, withRoute } from '@pipeline-builder/api-server';
import {
  SUPPORT_CASE_STATUSES,
  addCaseNote,
  assignCase,
  assignCases,
  closeCases,
  rateCase,
  createCannedResponse,
  deleteCannedResponse,
  listCannedResponses,
  updateCannedResponse,
  deleteCaseNote,
  findCaseByThread,
  isSupportContact,
  listCaseNotes,
  setCaseSeverity,
  setCaseStatus,
  transferCaseToContact,
  type SupportCaseStatus,
} from '@pipeline-builder/pipeline-data';
import { Router } from 'express';
import type { RequestHandler } from 'express';

/** Longest a staff note may be. Generous — it is a working note, not a field. */
const NOTE_MAX = 5000;

/** Most cases one bulk action may touch, so a click cannot rewrite the queue. */
const BULK_MAX = 100;

/** Longest free-text comment attached to a CSAT rating. */
const CSAT_COMMENT_MAX = 2000;

/** Bounds on a canned reply. The body matches the note bound — both are prose a
 *  staff member writes once, and a template is if anything shorter. */
const CANNED_TITLE_MAX = 200;
const CANNED_BODY_MAX = 5000;

/** Severities a tenant may choose at open, and staff may re-rank to. */
const SEVERITIES = ['normal', 'high', 'urgent'] as const;

/**
 * Statuses a TENANT may set.
 *
 * Deliberately not the full set. `awaiting_support` is ours to declare, not
 * theirs to demand, and `resolved` is a staff judgement — a tenant saying "this
 * is sorted" is `closed`, which is exactly what they mean and cannot be read as
 * us having fixed anything.
 */
const TENANT_STATUSES: readonly string[] = ['open', 'awaiting_customer', 'closed'];

/**
 * REOPENING A CLOSED CASE IS STAFF ONLY. Both sides may close.
 *
 * The asymmetry is deliberate and has two reasons.
 *
 * Product: `closed` is terminal, and a tenant who finished with a case should
 * not be able to undo that weeks later — a case that can come back from closed
 * has no end, and nothing downstream (ageing, reporting, the response clock) can
 * treat it as finished.
 *
 * Commercial: it is also the loophole that would let a tenant recycle ONE case
 * indefinitely instead of opening new ones, which under a per-contact case
 * allowance is a direct way to avoid the allowance. With this rule they have to
 * open a fresh case, which counts.
 *
 * `resolved` is deliberately NOT included. Moving `resolved` → `open` is a
 * tenant saying "that did not fix it", which is the feedback loop that makes
 * `resolved` mean anything at all and is the whole reason it is a separate state
 * from `closed`. Taking that away would be bad support, and it is not the same
 * loophole: every bounce is us having claimed a fix and the customer rejecting
 * it, which is a signal worth having.
 */
const TENANT_TERMINAL_STATUSES: readonly string[] = ['closed'];

export function createSupportCaseRoutes(): Router {
  const router = Router();

  /**
   * Load the case for a thread and check the caller may act on it at all.
   *
   * Returns the case, or null having already answered. Staff pass on any case;
   * a tenant must own the org the case belongs to — RLS would hide another
   * tenant's row anyway, so this turns an invisible row into an honest 404
   * rather than a confusing success.
   */
  const loadCase = async (
    threadId: string,
    orgId: string,
    staff: boolean,
    res: Parameters<typeof sendError>[0],
  ) => {
    const supportCase = await findCaseByThread(threadId);
    if (!supportCase) {
      sendError(res, 404, 'No support case for that thread', ErrorCode.NOT_FOUND);
      return null;
    }
    if (!staff && supportCase.orgId.toLowerCase() !== orgId.toLowerCase()) {
      sendError(res, 404, 'No support case for that thread', ErrorCode.NOT_FOUND);
      return null;
    }
    return supportCase;
  };

  // --- Status: both sides ----------------------------------------------------
  router.patch(
    '/support/:id/status',
    ...createAuthenticatedWithOrgRoute(),
    requirePermission('messages:read'),
    audited('support.case.status'),
    withRoute(async ({ req, res, ctx, orgId, userId }) => {
      const threadId = getParam(req.params, 'id');
      if (!threadId) return sendBadRequest(res, 'Case id is required', ErrorCode.MISSING_REQUIRED_FIELD);
      const status = (req.body as { status?: unknown } | undefined)?.status;
      if (typeof status !== 'string' || !(SUPPORT_CASE_STATUSES as readonly string[]).includes(status)) {
        return sendBadRequest(res, `status must be one of: ${SUPPORT_CASE_STATUSES.join(', ')}`, ErrorCode.VALIDATION_ERROR);
      }
      const staff = isSystemAdmin(req) || orgId === SYSTEM_ORG_ID;
      if (!staff && !TENANT_STATUSES.includes(status)) {
        // Naming the allowed set rather than just refusing: the distinction is
        // not obvious, and "resolved is ours to declare" is the sort of rule a
        // caller should be told rather than left to guess.
        return sendError(
          res,
          403,
          `You can set: ${TENANT_STATUSES.join(', ')}. "awaiting_support" and "resolved" are set by the support team.`,
          ErrorCode.INSUFFICIENT_PERMISSIONS,
        );
      }
      const supportCase = await loadCase(threadId, orgId, staff, res);
      if (!supportCase) return undefined;

      // Reopening a CLOSED case is staff only — see TENANT_TERMINAL_STATUSES.
      // Checked on the CURRENT status rather than the target, because the rule
      // is about the transition out of a terminal state and not about any
      // particular destination: closed -> closed is a harmless no-op, while
      // closed -> anything else is the reopen.
      if (!staff && TENANT_TERMINAL_STATUSES.includes(supportCase.status) && status !== supportCase.status) {
        return sendError(
          res,
          403,
          'This case is closed. Ask the support team to reopen it, or raise a new case.',
          ErrorCode.INSUFFICIENT_PERMISSIONS,
        );
      }

      const updated = await setCaseStatus(supportCase.id, status as SupportCaseStatus, userId);
      if (!updated) return sendError(res, 404, 'No support case for that thread', ErrorCode.NOT_FOUND);

      recordAudit({
        action: 'support.case.status',
        actorId: actorId({ userId }),
        orgId,
        affectedOrgId: supportCase.orgId,
        targetType: 'support_case',
        targetId: threadId,
        // `from`/`to` because the transition is the fact, not the end state —
        // a case bouncing between awaiting states is the thing an auditor reads.
        details: { caseNumber: supportCase.displayNumber, from: supportCase.status, to: status, byStaff: staff },
      });
      ctx.log('COMPLETED', 'Support case status changed', { threadId, from: supportCase.status, to: status });
      return sendSuccess(res, 200, { status: updated.status, awaitingTotalSeconds: updated.awaitingTotalSeconds });
    }),
  );

  // --- Severity: staff only (scope C2) --------------------------------------
  router.patch(
    '/support/:id/severity',
    ...createAuthenticatedWithOrgRoute(),
    requireSystemAdmin as RequestHandler,
    audited('support.case.severity'),
    withRoute(async ({ req, res, ctx, orgId, userId }) => {
      const threadId = getParam(req.params, 'id');
      if (!threadId) return sendBadRequest(res, 'Case id is required', ErrorCode.MISSING_REQUIRED_FIELD);
      const severity = (req.body as { severity?: unknown } | undefined)?.severity;
      if (typeof severity !== 'string' || !(SEVERITIES as readonly string[]).includes(severity)) {
        return sendBadRequest(res, `severity must be one of: ${SEVERITIES.join(', ')}`, ErrorCode.VALIDATION_ERROR);
      }
      const supportCase = await loadCase(threadId, orgId, true, res);
      if (!supportCase) return undefined;

      const applied = await setCaseSeverity(supportCase.id, severity, userId);
      if (!applied) return sendError(res, 404, 'No support case for that thread', ErrorCode.NOT_FOUND);

      recordAudit({
        action: 'support.case.severity',
        actorId: actorId({ userId }),
        orgId,
        affectedOrgId: supportCase.orgId,
        targetType: 'support_case',
        targetId: threadId,
        // The whole reason this action exists: a severity change moves which
        // target applies, so the trail has to show who re-ranked it and from
        // what — otherwise a downgrade before a breach is invisible.
        details: { caseNumber: supportCase.displayNumber, from: supportCase.severity, to: severity },
      });
      ctx.log('COMPLETED', 'Support case severity re-ranked', { threadId, from: supportCase.severity, to: severity });
      return sendSuccess(res, 200, { severity: applied });
    }),
  );

  // --- Staff owner ----------------------------------------------------------
  router.patch(
    '/support/:id/assign',
    ...createAuthenticatedWithOrgRoute(),
    requireSystemAdmin as RequestHandler,
    audited('support.case.assign'),
    withRoute(async ({ req, res, ctx, orgId, userId }) => {
      const threadId = getParam(req.params, 'id');
      if (!threadId) return sendBadRequest(res, 'Case id is required', ErrorCode.MISSING_REQUIRED_FIELD);
      const body = (req.body ?? {}) as { assignedTo?: unknown };
      // `null` is a legitimate value, not a missing one: it releases the case to
      // the unowned pool, which is how "I cannot take this" is said without
      // inventing a pseudo-assignee. So `undefined` is the error, not null.
      if (body.assignedTo !== null && typeof body.assignedTo !== 'string') {
        return sendBadRequest(res, 'assignedTo must be a user id, or null to release the case', ErrorCode.VALIDATION_ERROR);
      }
      const supportCase = await loadCase(threadId, orgId, true, res);
      if (!supportCase) return undefined;

      const updated = await assignCase(supportCase.id, body.assignedTo, userId);
      if (!updated) return sendError(res, 404, 'No support case for that thread', ErrorCode.NOT_FOUND);

      recordAudit({
        action: 'support.case.assign',
        actorId: actorId({ userId }),
        orgId,
        affectedOrgId: supportCase.orgId,
        targetType: 'support_case',
        targetId: threadId,
        details: { caseNumber: supportCase.displayNumber, from: supportCase.assignedTo, to: body.assignedTo },
      });
      ctx.log('COMPLETED', 'Support case assigned', { threadId, to: body.assignedTo });
      return sendSuccess(res, 200, { assignedTo: updated.assignedTo });
    }),
  );

  // --- Tenant owner ---------------------------------------------------------
  router.patch(
    '/support/:id/transfer',
    ...createAuthenticatedWithOrgRoute(),
    requirePermission('messages:read'),
    audited('support.case.transfer'),
    withRoute(async ({ req, res, ctx, orgId, userId }) => {
      const threadId = getParam(req.params, 'id');
      if (!threadId) return sendBadRequest(res, 'Case id is required', ErrorCode.MISSING_REQUIRED_FIELD);
      const target = (req.body as { tenantContact?: unknown } | undefined)?.tenantContact;
      if (typeof target !== 'string' || !target) {
        return sendBadRequest(res, 'tenantContact must be a user id', ErrorCode.VALIDATION_ERROR);
      }
      const supportCase = await loadCase(threadId, orgId, false, res);
      if (!supportCase) return undefined;

      /**
       * The target must be a live designated contact OF THIS CASE'S OWN ORG.
       *
       * Own-org, not the account subtree: the contact ALLOWANCE pools
       * subtree-wide, but ownership does not — accepting a sibling team's
       * contact here is exactly the cross-team case leak that rule exists to
       * prevent. So the scope passed is a single org id, never the expanded
       * subtree.
       */
      if (!(await isSupportContact([supportCase.orgId], target))) {
        return sendError(
          res,
          400,
          'That user is not a designated support contact for this organization',
          ErrorCode.VALIDATION_ERROR,
        );
      }

      const updated = await transferCaseToContact(supportCase.id, target, userId);
      if (!updated) return sendError(res, 404, 'No support case for that thread', ErrorCode.NOT_FOUND);

      recordAudit({
        action: 'support.case.transfer',
        actorId: actorId({ userId }),
        orgId,
        affectedOrgId: supportCase.orgId,
        targetType: 'support_case',
        targetId: threadId,
        // `createdBy` is untouched by a transfer and deliberately absent here:
        // who RAISED the case never changes, and recording it as part of a
        // handover would blur the one fact the trail must keep stable.
        details: { caseNumber: supportCase.displayNumber, from: supportCase.tenantContact, to: target },
      });
      ctx.log('COMPLETED', 'Support case transferred', { threadId, to: target });
      return sendSuccess(res, 200, { tenantContact: updated.tenantContact });
    }),
  );

  // --- Canned responses: STAFF ONLY, read and write --------------------------
  //
  // Not under `/support/:id` at all — a template belongs to no case. Mounted
  // first so `/support/canned` is never a candidate for a case id.
  //
  // System-wide rather than per-tenant: these are the vendor's own wording for
  // recurring questions, authored once and reused across every customer, so the
  // table carries no `org_id` and RLS does not apply to it. That is precisely
  // why the READ is gated as hard as the writes — there is no tenancy boundary
  // underneath to fall back on.
  router.get(
    '/support/canned',
    ...createAuthenticatedWithOrgRoute(),
    requireSystemAdmin as RequestHandler,
    withRoute(async ({ res }) => sendSuccess(res, 200, { responses: await listCannedResponses() })),
  );

  router.post(
    '/support/canned',
    ...createAuthenticatedWithOrgRoute(),
    requireSystemAdmin as RequestHandler,
    audited('support.canned.write'),
    withRoute(async ({ req, res, ctx, userId }) => {
      const body = (req.body ?? {}) as { title?: unknown; body?: unknown };
      const title = typeof body.title === 'string' ? body.title.trim() : '';
      const text = typeof body.body === 'string' ? body.body.trim() : '';
      if (!title || title.length > CANNED_TITLE_MAX) {
        return sendBadRequest(res, `title is required and must be at most ${CANNED_TITLE_MAX} characters`, ErrorCode.VALIDATION_ERROR);
      }
      if (!text || text.length > CANNED_BODY_MAX) {
        return sendBadRequest(res, `body is required and must be at most ${CANNED_BODY_MAX} characters`, ErrorCode.VALIDATION_ERROR);
      }
      const created = await createCannedResponse(title, text, userId);
      recordAudit({
        action: 'support.canned.write',
        actorId: actorId({ userId }),
        orgId: SYSTEM_ORG_ID,
        targetType: 'support_canned_response',
        targetId: created.id,
        // The TITLE but not the body: the title identifies which template moved,
        // and the body is the thing a reviewer would read in the template
        // itself rather than in a trail.
        details: { title, created: true },
      });
      ctx.log('COMPLETED', 'Canned response created', { id: created.id });
      return sendSuccess(res, 201, { response: created });
    }),
  );

  router.patch(
    '/support/canned/:id',
    ...createAuthenticatedWithOrgRoute(),
    requireSystemAdmin as RequestHandler,
    audited('support.canned.write'),
    withRoute(async ({ req, res, ctx, userId }) => {
      const id = getParam(req.params, 'id');
      if (!id) return sendBadRequest(res, 'Template id is required', ErrorCode.MISSING_REQUIRED_FIELD);
      const body = (req.body ?? {}) as { title?: unknown; body?: unknown };
      const fields: { title?: string; body?: string } = {};
      if (body.title !== undefined) {
        if (typeof body.title !== 'string' || !body.title.trim() || body.title.length > CANNED_TITLE_MAX) {
          return sendBadRequest(res, `title must be a non-empty string of at most ${CANNED_TITLE_MAX} characters`, ErrorCode.VALIDATION_ERROR);
        }
        fields.title = body.title.trim();
      }
      if (body.body !== undefined) {
        if (typeof body.body !== 'string' || !body.body.trim() || body.body.length > CANNED_BODY_MAX) {
          return sendBadRequest(res, `body must be a non-empty string of at most ${CANNED_BODY_MAX} characters`, ErrorCode.VALIDATION_ERROR);
        }
        fields.body = body.body.trim();
      }
      if (fields.title === undefined && fields.body === undefined) {
        return sendBadRequest(res, 'Nothing to change', ErrorCode.VALIDATION_ERROR);
      }
      const updated = await updateCannedResponse(id, fields, userId);
      // 404 rather than 409 on a retired template: from the caller's side it is
      // simply not there to edit, and resurrecting one should be a deliberate
      // new row rather than a side effect of fixing a typo.
      if (!updated) return sendError(res, 404, 'No such canned response', ErrorCode.NOT_FOUND);

      recordAudit({
        action: 'support.canned.write',
        actorId: actorId({ userId }),
        orgId: SYSTEM_ORG_ID,
        targetType: 'support_canned_response',
        targetId: id,
        details: { fields: Object.keys(fields) },
      });
      ctx.log('COMPLETED', 'Canned response updated', { id, fields: Object.keys(fields) });
      return sendSuccess(res, 200, { id });
    }),
  );

  router.delete(
    '/support/canned/:id',
    ...createAuthenticatedWithOrgRoute(),
    requireSystemAdmin as RequestHandler,
    audited('support.canned.write'),
    withRoute(async ({ req, res, ctx, userId }) => {
      const id = getParam(req.params, 'id');
      if (!id) return sendBadRequest(res, 'Template id is required', ErrorCode.MISSING_REQUIRED_FIELD);
      // SOFT: a retired template is still the explanation of what a past reply
      // said, and deleting the row would leave old correspondence unaccountable
      // for its own wording.
      const removed = await deleteCannedResponse(id, userId);
      if (!removed) return sendError(res, 404, 'No such canned response', ErrorCode.NOT_FOUND);
      recordAudit({
        action: 'support.canned.write',
        actorId: actorId({ userId }),
        orgId: SYSTEM_ORG_ID,
        targetType: 'support_canned_response',
        targetId: id,
        details: { retired: true },
      });
      ctx.log('COMPLETED', 'Canned response retired', { id });
      return sendSuccess(res, 200, { id });
    }),
  );

  // --- CSAT: TENANT ONLY ----------------------------------------------------
  //
  // The only write on a case that STAFF may not make, and that asymmetry is the
  // whole point: a vendor-settable satisfaction score is not a satisfaction
  // score. `requirePermission('messages:read')` plus the own-org check in
  // `loadCase`, with `staff: false` passed unconditionally.
  //
  // Not audited. The rating is the customer's opinion, stored on their own case
  // and visible to them; it changes no entitlement, no ownership and no clock.
  // Putting a 1-to-5 opinion in the central trail would add noise to a log read
  // for authorization questions. The route-coverage exception records this.
  router.patch(
    '/support/:id/satisfaction',
    ...createAuthenticatedWithOrgRoute(),
    requirePermission('messages:read'),
    withRoute(async ({ req, res, ctx, orgId }) => {
      const threadId = getParam(req.params, 'id');
      if (!threadId) return sendBadRequest(res, 'Case id is required', ErrorCode.MISSING_REQUIRED_FIELD);
      const body = (req.body ?? {}) as { satisfaction?: unknown; comment?: unknown };
      const score = body.satisfaction;
      if (typeof score !== 'number' || !Number.isInteger(score) || score < 1 || score > 5) {
        return sendBadRequest(res, 'satisfaction must be an integer from 1 to 5', ErrorCode.VALIDATION_ERROR);
      }
      if (body.comment !== undefined && body.comment !== null && typeof body.comment !== 'string') {
        return sendBadRequest(res, 'comment must be a string', ErrorCode.VALIDATION_ERROR);
      }
      const comment = typeof body.comment === 'string' ? body.comment.trim().slice(0, CSAT_COMMENT_MAX) : null;

      // staff: false unconditionally — this is the one route the desk is not
      // allowed to reach for a tenant, so there is no staff variant to admit.
      const supportCase = await loadCase(threadId, orgId, false, res);
      if (!supportCase) return undefined;

      const rated = await rateCase(supportCase.id, score, comment || null);
      if (!rated) {
        // Named, because "not closed yet" is the usual reason and is entirely
        // the customer's to fix by waiting.
        return sendError(
          res,
          409,
          'A case can only be rated once it is resolved or closed.',
          ErrorCode.VALIDATION_ERROR,
        );
      }
      // Labelled by the case's FROZEN level, which is the comparison worth
      // having: the levels are sold on different promises, so a premium average
      // below the standard one is a specific, actionable failure rather than
      // noise. Severity too, because a bad rating on an urgent case is a
      // different problem from a bad one on a question.
      observe('support_satisfaction', { level: supportCase.level, severity: supportCase.severity }, score);
      ctx.log('COMPLETED', 'Support case rated', { threadId, satisfaction: score });
      return sendSuccess(res, 200, { satisfaction: score });
    }),
  );

  // --- Bulk ownership: STAFF ONLY -------------------------------------------
  //
  // `/support/bulk` is TWO segments and every `:id` route here is three
  // (`/support/:id/status`, `.../assign`, …), so no parameterised pattern can
  // swallow the literal and declaration order does not matter for it. Worth
  // stating because the instinct is to mount it first: that instinct is right
  // in general, and the day somebody adds a 2-segment `PATCH /support/:id` the
  // literal MUST come before it. A test asserts that no such route exists.
  //
  // One route for both verbs rather than two, because the selection and the
  // staleness reporting are identical and the only difference is which store
  // function runs. Splitting them would duplicate the clamp, the validation and
  // the partial-result audit three times over.
  router.patch(
    '/support/bulk',
    ...createAuthenticatedWithOrgRoute(),
    requireSystemAdmin as RequestHandler,
    audited('support.case.assign'),
    withRoute(async ({ req, res, ctx, orgId, userId }) => {
      const body = (req.body ?? {}) as { threadIds?: unknown; action?: unknown; assignedTo?: unknown };
      const threadIds = Array.isArray(body.threadIds)
        ? body.threadIds.filter((v): v is string => typeof v === 'string' && v.length > 0)
        : [];
      if (threadIds.length === 0) return sendBadRequest(res, 'threadIds must be a non-empty array', ErrorCode.VALIDATION_ERROR);
      if (threadIds.length > BULK_MAX) {
        // Bounded so one click cannot rewrite the whole queue. The limit is on
        // the REQUEST rather than enforced by clamping, so a caller is told it
        // was refused instead of silently acting on a prefix.
        return sendBadRequest(res, `At most ${BULK_MAX} cases at a time`, ErrorCode.VALIDATION_ERROR);
      }
      if (body.action !== 'assign' && body.action !== 'close') {
        return sendBadRequest(res, "action must be 'assign' or 'close'", ErrorCode.VALIDATION_ERROR);
      }
      if (body.action === 'assign' && body.assignedTo !== null && typeof body.assignedTo !== 'string') {
        return sendBadRequest(res, 'assignedTo must be a user id, or null to release', ErrorCode.VALIDATION_ERROR);
      }

      // Thread ids are the API's currency; the store works in case ids. Resolved
      // one by one because a selection is bounded and this keeps the lookup the
      // same `findCaseByThread` every other route uses — including its
      // soft-delete predicate.
      const found = await Promise.all(threadIds.map(async (t) => ({ threadId: t, c: await findCaseByThread(t) })));
      const cases = found.filter((f): f is { threadId: string; c: NonNullable<typeof f.c> } => f.c !== null);
      if (cases.length === 0) return sendError(res, 404, 'None of those threads has a support case', ErrorCode.NOT_FOUND);

      const ids = cases.map((f) => f.c.id);
      const moved = body.action === 'close'
        ? await closeCases(ids, userId)
        : await assignCases(ids, body.assignedTo as string | null, userId);
      const movedSet = new Set(moved);
      const movedThreads = cases.filter((f) => movedSet.has(f.c.id)).map((f) => f.threadId);

      // ONE audit row per case, not one for the batch. A bulk action is a
      // convenience for the operator, never a reason for the trail to be
      // coarser: a dispute is about one case, and "it was part of a batch of
      // thirty" is not an answer.
      for (const f of cases.filter((x) => movedSet.has(x.c.id))) {
        recordAudit({
          action: body.action === 'close' ? 'support.case.status' : 'support.case.assign',
          actorId: actorId({ userId }),
          orgId,
          affectedOrgId: f.c.orgId,
          targetType: 'support_case',
          targetId: f.threadId,
          details: body.action === 'close'
            ? { caseNumber: f.c.displayNumber, from: f.c.status, to: 'closed', byStaff: true, bulk: true }
            : { caseNumber: f.c.displayNumber, from: f.c.assignedTo, to: body.assignedTo, bulk: true },
        });
      }

      ctx.log('COMPLETED', 'Bulk support action', {
        action: body.action, requested: threadIds.length, moved: movedThreads.length,
      });
      // The moved ids AND the count asked for, so a caller can say "27 of 30"
      // rather than reporting a success that silently skipped three. On a shared
      // queue a stale selection is the normal case, not an edge one.
      return sendSuccess(res, 200, { moved: movedThreads, requested: threadIds.length });
    }),
  );

  // --- Staff notes: STAFF ONLY, both directions -----------------------------
  //
  // The one surface on a case that the tenant must never see. It is a separate
  // TABLE rather than a flag on `messages` precisely so that cannot happen by
  // omission: `messages` is read through one shared visibility predicate, and a
  // flag there would leak a note from any read path that forgot the extra
  // condition. A separate table has to be joined deliberately.
  //
  // `requireSystemAdmin` at the ROUTE layer, not inside the handler, so the
  // route table carries the gate where route-coverage can see it.
  router.get(
    '/support/:id/notes',
    ...createAuthenticatedWithOrgRoute(),
    requireSystemAdmin as RequestHandler,
    withRoute(async ({ req, res, orgId }) => {
      const threadId = getParam(req.params, 'id');
      if (!threadId) return sendBadRequest(res, 'Case id is required', ErrorCode.MISSING_REQUIRED_FIELD);
      const supportCase = await loadCase(threadId, orgId, true, res);
      if (!supportCase) return undefined;
      const notes = await listCaseNotes(supportCase.id);
      return sendSuccess(res, 200, { notes });
    }),
  );

  router.post(
    '/support/:id/notes',
    ...createAuthenticatedWithOrgRoute(),
    requireSystemAdmin as RequestHandler,
    audited('support.case.note'),
    withRoute(async ({ req, res, ctx, orgId, userId }) => {
      const threadId = getParam(req.params, 'id');
      if (!threadId) return sendBadRequest(res, 'Case id is required', ErrorCode.MISSING_REQUIRED_FIELD);
      const content = (req.body as { content?: unknown } | undefined)?.content;
      if (typeof content !== 'string' || !content.trim()) {
        return sendBadRequest(res, 'content is required', ErrorCode.VALIDATION_ERROR);
      }
      if (content.length > NOTE_MAX) {
        return sendBadRequest(res, `content must be at most ${NOTE_MAX} characters`, ErrorCode.VALIDATION_ERROR);
      }
      const supportCase = await loadCase(threadId, orgId, true, res);
      if (!supportCase) return undefined;

      // The note's tenant scope comes from the CASE, never from the staff
      // author's own org — which is the system org, and would put every note
      // outside the scope meant to contain it.
      const note = await addCaseNote(supportCase.id, supportCase.orgId, content.trim(), userId);

      recordAudit({
        action: 'support.case.note',
        actorId: actorId({ userId }),
        orgId,
        affectedOrgId: supportCase.orgId,
        targetType: 'support_case',
        targetId: threadId,
        // METADATA ONLY — never the note body. A staff note is internal
        // assessment of a customer, and the central trail is read far more
        // widely than the queue is.
        details: { caseNumber: supportCase.displayNumber, noteId: note.id, length: content.trim().length },
      });
      ctx.log('COMPLETED', 'Support case note added', { threadId, noteId: note.id });
      return sendSuccess(res, 201, { note });
    }),
  );

  router.delete(
    '/support/:id/notes/:noteId',
    ...createAuthenticatedWithOrgRoute(),
    requireSystemAdmin as RequestHandler,
    audited('support.case.note'),
    withRoute(async ({ req, res, ctx, orgId, userId }) => {
      const threadId = getParam(req.params, 'id');
      const noteId = getParam(req.params, 'noteId');
      if (!threadId || !noteId) return sendBadRequest(res, 'Case id and note id are required', ErrorCode.MISSING_REQUIRED_FIELD);
      const supportCase = await loadCase(threadId, orgId, true, res);
      if (!supportCase) return undefined;

      // SOFT delete: a note records what the desk believed at the time, and a
      // dispute may turn on it.
      const removed = await deleteCaseNote(noteId, userId);
      if (!removed) return sendError(res, 404, 'No such note on that case', ErrorCode.NOT_FOUND);

      recordAudit({
        action: 'support.case.note',
        actorId: actorId({ userId }),
        orgId,
        affectedOrgId: supportCase.orgId,
        targetType: 'support_case',
        targetId: threadId,
        details: { caseNumber: supportCase.displayNumber, noteId, deleted: true },
      });
      ctx.log('COMPLETED', 'Support case note deleted', { threadId, noteId });
      return sendSuccess(res, 200, { noteId });
    }),
  );

  return router;
}
