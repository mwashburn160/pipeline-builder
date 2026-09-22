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
 *
 * Two request shapes:
 *  - **tenant email** (`compliance`): `{ orgId, targetUsers, subject, text }`,
 *    tenant-bound to the caller's org.
 *  - **ecosystem notice** (`plugin`, docs/plans/plugin-ecosystem.md §5b): an
 *    api-core `EcosystemNotifyRequest` — recipient RULES resolved here at send
 *    time, per-user `ecosystem.*` email preferences, in-app copy + individual
 *    emails. Ecosystem notices legitimately span orgs (a publisher's managers,
 *    each installing org's approvers, the system org's moderators), so they are
 *    not tenant-bound; instead only the `plugin` service may send them, and the
 *    rules can only reach the audiences §5b defines.
 */

import { createLogger, sendError, sendSuccess, errorMessage, parseEcosystemNotifyRequest, serviceNameOf } from '@pipeline-builder/api-core';
import type { Request, Response } from 'express';
import { config } from '../config/index.js';
import { toOrgId } from '../helpers/org-id.js';
import { resolveServiceTenant } from '../helpers/service-tenant.js';
import { User, UserOrganization } from '../models/index.js';
import { deliverEcosystemNotification } from '../services/ecosystem-notifications.js';
import { emailService } from '../utils/email.js';

const logger = createLogger('notify-email-controller');

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

/** The only service allowed to send ecosystem notices through the relay. */
const ECOSYSTEM_NOTICE_CALLER = 'plugin';

async function notifyEcosystem(req: Request, res: Response): Promise<void> {
  if (serviceNameOf(req.user) !== ECOSYSTEM_NOTICE_CALLER) {
    return sendError(res, 403, 'Only the plugin service may send ecosystem notices');
  }
  const parsed = parseEcosystemNotifyRequest(req.body);
  if (typeof parsed === 'string') return sendError(res, 400, parsed);
  try {
    const report = await deliverEcosystemNotification(parsed);
    return sendSuccess(res, 200, { ok: true, ...report });
  } catch (err) {
    logger.warn('Ecosystem notice delivery failed', { event: parsed.event, error: errorMessage(err) });
    return sendError(res, 500, 'Failed to deliver ecosystem notice');
  }
}

export async function notifyEmail(req: Request, res: Response): Promise<void> {
  // An ecosystem notice names recipient RULES; a tenant email names an org.
  if (req.body && typeof req.body === 'object' && 'recipients' in req.body) return notifyEcosystem(req, res);
  // The tenant-email shape is compliance's alone.
  if (serviceNameOf(req.user) === ECOSYSTEM_NOTICE_CALLER) {
    return sendError(res, 400, 'recipients is required for an ecosystem notice');
  }
  const body = req.body as { orgId?: unknown; targetUsers?: unknown; subject?: unknown; text?: unknown };

  if (typeof body.orgId !== 'string' || !body.orgId) return sendError(res, 400, 'orgId is required');
  if (typeof body.subject !== 'string' || !body.subject) return sendError(res, 400, 'subject is required');
  if (typeof body.text !== 'string' || !body.text) return sendError(res, 400, 'text is required');
  const targetUsers = Array.isArray(body.targetUsers)
    ? body.targetUsers.filter((u): u is string => typeof u === 'string')
    : null;

  // Tenant binding (mirrors /audit/events): a non-sysadmin service token may only
  // email its OWN org's users — otherwise any service token could email any
  // org's admins an arbitrary subject/body.
  if (resolveServiceTenant(req, res, body.orgId) === null) return;

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
      orgId: body.orgId, error: errorMessage(err),
    });
    return sendError(res, 500, 'Failed to send email');
  }
}

/**
 * GET /internal/notify-email/status — `{ enabled }` from EMAIL_ENABLED. Reports
 * the instance switch only (no provider/host/sender details): the caller needs
 * a yes/no to decide whether a flow that depends on email may run at all.
 */
export function notifyEmailStatus(_req: Request, res: Response): void {
  return sendSuccess(res, 200, { enabled: config.email.enabled === true });
}
