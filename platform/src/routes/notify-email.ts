// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * POST /internal/notify-email — internal service-to-service email send.
 *
 * Lets other services (e.g. compliance) send email without owning an SMTP/SES
 * stack: platform owns both the EmailService and the user directory, so it
 * resolves recipients here. The caller passes `{ orgId, targetUsers, subject,
 * text }`; recipients are `targetUsers` (intersected with active org membership)
 * or, when null/empty, all active org admins/owners.
 *
 * Auth: service-token only (rejects user JWTs), same gate as /audit/events.
 */

import { createLogger, isSystemAdmin, sendError, sendSuccess } from '@pipeline-builder/api-core';
import { Router, type Request, type Response } from 'express';
import { toOrgId } from '../helpers/org-id.js';
import { requireServiceAuth } from '../middleware/index.js';
import { User, UserOrganization } from '../models/index.js';
import { emailService } from '../utils/email.js';

const logger = createLogger('notify-email-routes');
const router: Router = Router();

/** Resolve recipient email addresses for an org. `targetUsers` (when non-empty)
 *  is intersected with active membership so a misconfigured list can't email
 *  users outside the org; null/empty falls back to all active admins/owners.
 *  Membership is filtered in JS (orgs are small and this only runs when email
 *  is enabled), which avoids Mongoose's strict union typing on `$in`. */
async function resolveRecipientEmails(orgId: string, targetUsers: string[] | null): Promise<string[]> {
  const memberships = await UserOrganization.find({ organizationId: toOrgId(orgId), isActive: true }).lean();

  const wanted = targetUsers && targetUsers.length > 0
    ? memberships.filter((m) => targetUsers.includes(String(m.userId)))
    : memberships.filter((m) => m.role === 'owner' || m.role === 'admin');
  if (wanted.length === 0) return [];

  const userIds = wanted.map((m) => m.userId);
  const users = await User.find({ _id: { $in: userIds } }, 'email').lean();
  return users.map((u) => u.email).filter((e): e is string => typeof e === 'string' && e.length > 0);
}

export async function handleNotifyEmail(req: Request, res: Response) {
  const body = req.body as { orgId?: unknown; targetUsers?: unknown; subject?: unknown; text?: unknown };

  if (typeof body.orgId !== 'string' || !body.orgId) return sendError(res, 400, 'orgId is required');
  if (typeof body.subject !== 'string' || !body.subject) return sendError(res, 400, 'subject is required');
  if (typeof body.text !== 'string' || !body.text) return sendError(res, 400, 'text is required');
  const targetUsers = Array.isArray(body.targetUsers)
    ? body.targetUsers.filter((u): u is string => typeof u === 'string')
    : null;

  // Tenant binding — mirror /audit/events. `requireServiceAuth` only proves the
  // caller is *a* service; the service-token's own `organizationId` is the
  // authoritative tenant. A non-sysadmin service token may only email its OWN
  // org's users — otherwise any service token could email any org's admins with
  // an arbitrary subject/body. A sysadmin/system service token (isSuperAdmin)
  // may legitimately target any org.
  const tokenOrgId = req.user?.organizationId;
  const isSysadminService = isSystemAdmin(req);
  if (tokenOrgId && body.orgId !== tokenOrgId && !isSysadminService) {
    return sendError(res, 403, 'orgId does not match authenticated service org');
  }

  try {
    const emails = await resolveRecipientEmails(body.orgId, targetUsers);
    if (emails.length === 0) {
      // No recipients isn't an error — the org may have no admins / no matching
      // users. Report it so the caller can log a zero-recipient delivery.
      return sendSuccess(res, 200, { ok: true, recipientCount: 0 });
    }
    const ok = await emailService.send({ to: emails, subject: body.subject, text: body.text });
    return sendSuccess(res, 200, { ok, recipientCount: emails.length });
  } catch (err) {
    logger.warn('Notify-email send failed', {
      orgId: body.orgId, error: err instanceof Error ? err.message : String(err),
    });
    return sendError(res, 500, 'Failed to send email');
  }
}

router.post('/', requireServiceAuth, handleNotifyEmail);

export default router;
