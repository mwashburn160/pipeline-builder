// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * MFA recovery over HTTP — the TWO-PERSON reset, plus a sysadmin's direct reset
 * for an org with no second admin. The rules live in `services/mfa-recovery.ts`;
 * this file validates, checks tenancy, audits and maps errors.
 *
 *   GET  /organization/:id/mfa-resets                        — pending + recent
 *   POST /organization/:id/mfa-resets                        — request (admin, aal 2, step-up)
 *   POST /organization/:id/mfa-resets/:requestId/approve     — approve (another admin, aal 2, strong step-up)
 *   POST /organization/:id/mfa-resets/:requestId/deny        — deny / withdraw
 *   POST /admin/users/:id/mfa-reset                          — sysadmin direct (aal 2, strong step-up)
 *
 * TENANCY is `canAdministerOrg` — a sysadmin, an admin/owner of the org, or an
 * admin/owner of an ANCESTOR org — on the org the request belongs to; `:id` may
 * be that org or an ancestor of it (a parent admin works from the parent's
 * page). Every event is audited under the REAL actor (the signed-in person),
 * never a self-asserted name.
 */

import { getParam, isSystemAdmin, sendError, sendSuccess } from '@pipeline-builder/api-core';
import type { Request } from 'express';
import { z } from 'zod';
import { audit } from '../helpers/audit.js';
import { canAdministerOrg, requireAuth, withController, type ErrorMap } from '../helpers/controller-helper.js';
import { expandOrgScope } from '../helpers/org-hierarchy.js';
import { incCounter } from '../observability/metrics.js';
import {
  MFA_RESET_ALREADY_PENDING,
  MFA_RESET_EXPIRED,
  MFA_RESET_GRACE_MAX_HOURS,
  MFA_RESET_NOT_FOUND,
  MFA_RESET_NOT_MEMBER,
  MFA_RESET_NOT_PENDING,
  MFA_RESET_PLATFORM_ADMIN,
  MFA_RESET_SECOND_PERSON_REQUIRED,
  MFA_RESET_SELF,
  approveMfaReset as approve,
  denyMfaReset as deny,
  directMfaReset as direct,
  getMfaReset,
  listMfaResets as list,
  requestMfaReset as request,
  type FactorResetResult,
  type MfaResetRequestView,
} from '../services/mfa-recovery.js';
import { validateBody } from '../utils/validation.js';

export const MFA_RESET_ERROR_MAP: ErrorMap = {
  [MFA_RESET_NOT_FOUND]: { status: 404, message: 'MFA reset request not found', code: MFA_RESET_NOT_FOUND },
  [MFA_RESET_NOT_MEMBER]: { status: 404, message: 'That person is not an active member of this organization', code: MFA_RESET_NOT_MEMBER },
  [MFA_RESET_SELF]: {
    status: 409,
    message: 'You can\'t reset your own two-factor authentication — use a recovery code, or ask another admin.',
    code: MFA_RESET_SELF,
  },
  [MFA_RESET_PLATFORM_ADMIN]: {
    status: 403,
    message: 'A platform administrator\'s factors can only be reset by the platform operators.',
    code: MFA_RESET_PLATFORM_ADMIN,
  },
  [MFA_RESET_ALREADY_PENDING]: {
    status: 409,
    message: 'A reset for this person is already waiting for approval.',
    code: MFA_RESET_ALREADY_PENDING,
  },
  [MFA_RESET_NOT_PENDING]: { status: 409, message: 'This request has already been decided.', code: MFA_RESET_NOT_PENDING },
  [MFA_RESET_EXPIRED]: { status: 410, message: 'This request expired before it was approved. File a new one.', code: MFA_RESET_EXPIRED },
  [MFA_RESET_SECOND_PERSON_REQUIRED]: {
    status: 403,
    message: 'A reset must be approved by a different admin than the one who requested it (and never by the person being reset).',
    code: MFA_RESET_SECOND_PERSON_REQUIRED,
  },
};

const objectId = z.string().regex(/^[a-f0-9]{24}$/i, 'must be a user id');
const reason = z.string().trim().min(10, 'give a reason of at least 10 characters').max(500);
const graceHours = z.number().int().min(1).max(MFA_RESET_GRACE_MAX_HOURS).optional();

const requestSchema = z.object({ userId: objectId, reason }).strict();
const approveSchema = z.object({ graceHours }).strict();
const denySchema = z.object({ note: z.string().trim().max(500).optional() }).strict();
const directSchema = z.object({ reason, graceHours }).strict();

function actorOf(req: Request) {
  return { id: req.user!.sub, email: req.user!.email, isSuperAdmin: req.user!.isSuperAdmin === true };
}

/** The request, checked to belong to `:id` (the org or a team beneath it) and
 *  to an org the caller administers. Sends the refusal and returns null. */
async function loadActionable(req: Request, res: Parameters<typeof sendError>[0]): Promise<MfaResetRequestView | null> {
  const id = getParam(req.params, 'id')!;
  const requestId = getParam(req.params, 'requestId')!;
  const found = await getMfaReset(requestId);
  const scope = await expandOrgScope(id);
  if (!scope.includes(found.organizationId)) {
    sendError(res, 404, MFA_RESET_ERROR_MAP[MFA_RESET_NOT_FOUND].message, MFA_RESET_NOT_FOUND);
    return null;
  }
  if (!(await canAdministerOrg(req, found.organizationId))) {
    sendError(res, 403, 'Only an owner or admin of this organization (or of a parent organization) can act on this request');
    return null;
  }
  return found;
}

function resultDetails(result: FactorResetResult) {
  return {
    passkeysRemoved: result.passkeysRemoved,
    totpRemoved: result.totpRemoved,
    recoveryCodesRemoved: result.recoveryCodesRemoved,
    graceUntil: result.graceUntil.toISOString(),
  };
}

/** GET /organization/:id/mfa-resets */
export const listMfaResets = withController('List MFA resets', async (req, res) => {
  if (!requireAuth(req, res)) return;
  const id = getParam(req.params, 'id')!;
  if (!(await canAdministerOrg(req, id))) {
    return sendError(res, 403, 'Only an owner or admin of this organization can see its MFA reset requests');
  }
  sendSuccess(res, 200, { requests: await list(await expandOrgScope(id)) });
}, MFA_RESET_ERROR_MAP);

/** POST /organization/:id/mfa-resets — body `{ userId, reason }`. */
export const requestMfaReset = withController('Request MFA reset', async (req, res) => {
  if (!requireAuth(req, res)) return;
  const id = getParam(req.params, 'id')!;
  if (!(await canAdministerOrg(req, id))) {
    return sendError(res, 403, 'Only an owner or admin of this organization can request an MFA reset');
  }
  const body = validateBody(requestSchema, req.body, res);
  if (!body) return;

  const created = await request({ organizationId: id, targetUserId: body.userId, requester: actorOf(req), reason: body.reason });
  audit(req, 'auth.mfa.reset_requested', {
    targetType: 'user',
    targetId: created.targetUserId,
    affectedOrgId: id,
    details: { requestId: created.id, targetEmail: created.targetEmail, reason: created.reason, expiresAt: created.expiresAt },
  });
  incCounter('platform_mfa_resets_total', { stage: 'requested' });
  sendSuccess(res, 201, { request: created }, 'Reset requested — another admin must approve it within 24 hours');
}, MFA_RESET_ERROR_MAP);

/** POST /organization/:id/mfa-resets/:requestId/approve — body `{ graceHours? }`. */
export const approveMfaReset = withController('Approve MFA reset', async (req, res) => {
  if (!requireAuth(req, res)) return;
  const body = validateBody(approveSchema, req.body ?? {}, res);
  if (!body) return;
  const found = await loadActionable(req, res);
  if (!found) return;

  const { request: approved, result } = await approve({ requestId: found.id, approver: actorOf(req), graceHours: body.graceHours });
  audit(req, 'auth.mfa.reset_approved', {
    targetType: 'user',
    targetId: approved.targetUserId,
    affectedOrgId: approved.organizationId,
    details: {
      requestId: approved.id,
      targetEmail: approved.targetEmail,
      requestedBy: approved.requestedBy,
      requestedByEmail: approved.requestedByEmail,
      reason: approved.reason,
      approverIsSysadmin: isSystemAdmin(req),
      ...resultDetails(result),
    },
  });
  incCounter('platform_mfa_resets_total', { stage: 'approved' });
  sendSuccess(res, 200, { request: approved }, `Two-factor authentication reset for ${approved.targetEmail}`);
}, MFA_RESET_ERROR_MAP);

/** POST /organization/:id/mfa-resets/:requestId/deny — body `{ note? }`. */
export const denyMfaReset = withController('Deny MFA reset', async (req, res) => {
  if (!requireAuth(req, res)) return;
  const body = validateBody(denySchema, req.body ?? {}, res);
  if (!body) return;
  const found = await loadActionable(req, res);
  if (!found) return;

  const denied = await deny({ requestId: found.id, actor: actorOf(req), note: body.note });
  const withdrawn = denied.requestedBy === req.user!.sub;
  audit(req, 'auth.mfa.reset_denied', {
    targetType: 'user',
    targetId: denied.targetUserId,
    affectedOrgId: denied.organizationId,
    details: {
      requestId: denied.id,
      targetEmail: denied.targetEmail,
      requestedBy: denied.requestedBy,
      withdrawn,
      ...(body.note ? { note: body.note } : {}),
    },
  });
  incCounter('platform_mfa_resets_total', { stage: withdrawn ? 'withdrawn' : 'denied' });
  sendSuccess(res, 200, { request: denied }, withdrawn ? 'Request withdrawn' : 'Request denied');
}, MFA_RESET_ERROR_MAP);

/** POST /admin/users/:id/mfa-reset — body `{ reason, graceHours? }` (sysadmin). */
export const directMfaReset = withController('Direct MFA reset', async (req, res) => {
  if (!requireAuth(req, res)) return;
  const body = validateBody(directSchema, req.body, res);
  if (!body) return;
  const targetUserId = getParam(req.params, 'id')!;

  const result = await direct({ targetUserId, actor: actorOf(req), graceHours: body.graceHours });
  audit(req, 'auth.mfa.direct_reset', {
    targetType: 'user',
    targetId: result.userId,
    details: {
      targetEmail: result.email,
      reason: body.reason,
      // The single-person path — no second admin approved this.
      direct: true,
      ...resultDetails(result),
    },
  });
  incCounter('platform_mfa_resets_total', { stage: 'direct' });
  sendSuccess(res, 200, { reset: { ...resultDetails(result), userId: result.userId, email: result.email } },
    `Two-factor authentication reset for ${result.email}`);
}, MFA_RESET_ERROR_MAP);
