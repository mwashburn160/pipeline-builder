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
 * Five request shapes, told apart by the body:
 *  - **tenant email** (`compliance`, `reporting`): `{ orgId, targetUsers, subject,
 *    text }`, tenant-bound to the caller's org.
 *  - **report email** (`reporting`): `{ orgId, subject, text, html?,
 *    reportRecipients }` — one message per verified address (see `notifyReport`).
 *  - **quota notice** (`quota`): `{ quotaNotice: true, orgId, subject, text }` —
 *    a threshold notice to the org's admins/owners and billing contacts, resolved
 *    here, tenant-bound (see `notifyQuota`).
 *  - **offer notice** (`billing`): `{ offerNotice: true, orgId, subject, text }` —
 *    an EXPANSION OFFER to those same people, on its own leg so a warning and a
 *    solicitation are never the same event (see `notifyOffer`).
 *  - **ecosystem notice** (`plugin`): an
 *    api-core `EcosystemNotifyRequest` — recipient RULES resolved here at send
 *    time, per-user `ecosystem.*` email preferences, in-app copy + individual
 *    emails. Ecosystem notices legitimately span orgs (a publisher's managers,
 *    each installing org's approvers, the system org's moderators), so they are
 *    not tenant-bound; instead only the `plugin` service may send them, and the
 *    rules can only reach the ecosystem's own audiences (publisher managers,
 *    installing orgs' approvers, moderators, superadmins).
 */

import { createLogger, sendError, sendSuccess, errorMessage, parseEcosystemNotifyRequest, recordAuthzDenial, serviceNameOf } from '@pipeline-builder/api-core';
import type { Request, Response } from 'express';
import { config } from '../config/index.js';
import { ADMIN_ORG_ROLES, isAdminOrgRole } from '@pipeline-builder/api-core/wire-vocabulary';
import { toOrgId } from '../helpers/org-id.js';
import { resolveServiceTenant } from '../helpers/service-tenant.js';
import { User, UserOrganization } from '../models/index.js';
import { deliverEcosystemNotification, holdersOfPermission } from '../services/ecosystem-notifications.js';
import { emailService } from '../utils/email.js';
import { notifyEmailSchema, notifyOfferEmailSchema, notifyQuotaEmailSchema, notifyReportEmailSchema, validateBody } from '../utils/validation.js';

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
    : memberships.filter((m) => isAdminOrgRole(m.role));
  return emailsOf(wanted.map((m) => String(m.userId)));
}

/** Deduped, non-empty email addresses of `userIds`. */
async function emailsOf(userIds: readonly string[]): Promise<string[]> {
  if (userIds.length === 0) return [];
  const users = await User.find({ _id: { $in: [...new Set(userIds)] } }, 'email').lean();
  return [...new Set(users.map((u) => u.email).filter((e): e is string => typeof e === 'string' && e.length > 0))];
}

/** The only service allowed to send quota threshold notices. */
const QUOTA_NOTICE_CALLER = 'quota';

/**
 * Mail a quota threshold notice to the people who can act on it: the org's active
 * admins/owners (they can cut usage) PLUS its billing contacts — active members whose
 * Roles grant `billing:manage` (they can buy a bundle or upgrade the tier), who may be
 * neither admin nor owner. Resolved here, not by the caller: the quota service knows
 * counters, not people, and letting it name recipients would make a quota token a way
 * to mail anyone in the org.
 *
 * ONE message with a `to:` list, like the tenant leg and unlike the report leg: these
 * are the org's own staff, who already see one another in the member list.
 *
 * Tenant-bound: the quota service mints its token scoped to the account ROOT it is
 * notifying, so a token for org A cannot mail org B's admins whatever the body says.
 */
async function notifyQuota(req: Request, res: Response): Promise<void> {
  if (serviceNameOf(req.user) !== QUOTA_NOTICE_CALLER) {
    recordAuthzDenial(req, `internal-service (${QUOTA_NOTICE_CALLER})`);
    return sendError(res, 403, 'Only the quota service may send quota notices');
  }
  const body = validateBody(notifyQuotaEmailSchema, req.body, res);
  if (!body) return;
  if (resolveServiceTenant(req, res, body.orgId) === null) return;

  try {
    const [admins, billingContacts] = await Promise.all([
      UserOrganization.find({ organizationId: toOrgId(body.orgId), isActive: true, role: { $in: [...ADMIN_ORG_ROLES] } })
        .select('userId').lean(),
      holdersOfPermission(body.orgId, 'billing:manage'),
    ]);
    const emails = await emailsOf([...admins.map((m) => String(m.userId)), ...billingContacts]);
    if (emails.length === 0) {
      // Not an error: report it so the quota service logs a zero-recipient notice
      // rather than retrying one nobody can receive.
      return sendSuccess(res, 200, { ok: true, recipientCount: 0 });
    }
    const ok = await emailService.send({ to: emails, subject: body.subject, text: body.text });
    return sendSuccess(res, 200, { ok, recipientCount: emails.length });
  } catch (err) {
    logger.warn('Quota notice send failed', { orgId: body.orgId, error: errorMessage(err) });
    return sendError(res, 500, 'Failed to send quota notice');
  }
}

/** The only service allowed to send expansion-offer notices. */
const OFFER_NOTICE_CALLER = 'billing';

/**
 * Mail an EXPANSION OFFER to the people who can act on it (Phase 3).
 *
 * The same recipients as a quota notice — the org's admins/owners plus its
 * billing contacts — and resolved HERE for the same reason: billing knows
 * subscriptions, not people, and letting it name recipients would make a billing
 * token a way to mail anyone in the org.
 *
 * A SEPARATE LEG from the quota notice, deliberately. The plan says an offer
 * should ride the same CHANNEL rather than open a second one the account has to
 * learn — but the same channel is not the same message: one is a warning the
 * account needs and the other is a solicitation it can switch off, and the relay
 * must be able to tell them apart in its own logs and counters. Folding offers
 * into `quotaNotice` would make "we emailed them a warning" and "we emailed them
 * an advert" the same event.
 *
 * The consent AND (D6 — notices off suppresses offers on this channel) is
 * applied by the CALLER, which holds both switches from its profile read. It is
 * not re-checked here: platform does not own either switch, and a second
 * evaluation against a different read is how the two start disagreeing.
 */
async function notifyOffer(req: Request, res: Response): Promise<void> {
  if (serviceNameOf(req.user) !== OFFER_NOTICE_CALLER) {
    recordAuthzDenial(req, `internal-service (${OFFER_NOTICE_CALLER})`);
    return sendError(res, 403, 'Only the billing service may send offer notices');
  }
  const body = validateBody(notifyOfferEmailSchema, req.body, res);
  if (!body) return;
  if (resolveServiceTenant(req, res, body.orgId) === null) return;

  try {
    const [admins, billingContacts] = await Promise.all([
      UserOrganization.find({ organizationId: toOrgId(body.orgId), isActive: true, role: { $in: [...ADMIN_ORG_ROLES] } })
        .select('userId').lean(),
      holdersOfPermission(body.orgId, 'billing:manage'),
    ]);
    const emails = await emailsOf([...admins.map((m) => String(m.userId)), ...billingContacts]);
    // Not an error, same as the quota leg: report it so the caller can log a
    // zero-recipient offer rather than retrying one nobody can receive.
    if (emails.length === 0) return sendSuccess(res, 200, { ok: true, recipientCount: 0 });

    const ok = await emailService.send({ to: emails, subject: body.subject, text: body.text });
    return sendSuccess(res, 200, { ok, recipientCount: emails.length });
  } catch (err) {
    logger.warn('Offer notice send failed', { orgId: body.orgId, error: errorMessage(err) });
    return sendError(res, 500, 'Failed to send offer notice');
  }
}

/** The only service allowed to send ecosystem notices through the relay. */
const ECOSYSTEM_NOTICE_CALLER = 'plugin';

/** The only service allowed to mail a report to externally-verified addresses. */
const REPORT_EMAIL_CALLER = 'reporting';

/**
 * Mail a stakeholder report to addresses the reporting service verified.
 *
 * ONE MESSAGE PER ADDRESS, and not as a nicety. The tenant leg above joins its
 * recipients into a single `to:` header, which is right for an org's own admins and
 * wrong here: report recipients are managers at different companies, so a shared
 * header would disclose every address to all of them, and only one of them could have
 * been given an unsubscribe link. Per-address sending is also what makes a bounce
 * attributable — the caller suppresses an address after three, and it can only do that
 * if it learns WHICH address failed.
 *
 * Platform does not verify these addresses and does not try to: reporting owns the
 * double opt-in, the allowed-domain policy and the unsubscribe state. What platform
 * enforces is the ceiling — this caller only, its own org only, and at most
 * `REPORT_EMAIL_MAX_RECIPIENTS` per send.
 */
async function notifyReport(req: Request, res: Response): Promise<void> {
  if (serviceNameOf(req.user) !== REPORT_EMAIL_CALLER) {
    recordAuthzDenial(req, `internal-service (${REPORT_EMAIL_CALLER})`);
    return sendError(res, 403, 'Only the reporting service may send report email');
  }
  const body = validateBody(notifyReportEmailSchema, req.body, res);
  if (!body) return;
  // Tenant-bound exactly like the leg above: a reporting token scoped to org A cannot
  // mail org B's report, whatever the body says.
  if (resolveServiceTenant(req, res, body.orgId) === null) return;

  const sent: string[] = [];
  const failed: string[] = [];
  for (const recipient of body.reportRecipients) {
    try {
      // `send` resolves false (rather than throwing) when the transport refuses, so
      // both arms have to be handled or a refused address would count as delivered.
      const ok = await emailService.send({
        to: recipient.email,
        subject: body.subject,
        text: body.text,
        ...(body.html ? { html: body.html } : {}),
        ...(recipient.unsubscribeUrl
          // RFC 8058: the mail client's own unsubscribe button. A report a manager cannot
          // get rid of from their inbox is one they will filter instead, and a filtered
          // report is worse than an unsubscribed one — nobody learns. The `-Post` header
          // is what makes the client POST rather than follow a link, which is also what
          // keeps a mail-security scanner from unsubscribing people by prefetching.
          ? {
            headers: {
              'List-Unsubscribe': `<${recipient.unsubscribeUrl}>`,
              'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
            },
          }
          : {}),
      });
      (ok ? sent : failed).push(recipient.email);
    } catch (err) {
      // The ADDRESS never reaches the log — it is the PII this whole shape exists to
      // keep contained. The caller learns which one failed from the response.
      logger.warn('Report email send failed for one recipient', { orgId: body.orgId, error: errorMessage(err) });
      failed.push(recipient.email);
    }
  }
  return sendSuccess(res, 200, { ok: failed.length === 0, sent, failed });
}

async function notifyEcosystem(req: Request, res: Response): Promise<void> {
  if (serviceNameOf(req.user) !== ECOSYSTEM_NOTICE_CALLER) {
    recordAuthzDenial(req, `internal-service (${ECOSYSTEM_NOTICE_CALLER})`);
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
  // Four shapes, told apart by the BODY, each then checking its own caller. Dispatching
  // on the caller instead would tie a service to one leg, and `reporting` legitimately
  // uses two: the report leg for managers, the tenant leg for the one-address notice
  // that tells a lead their run is ready.
  const raw = req.body as Record<string, unknown> | undefined;
  if (raw && typeof raw === 'object' && 'reportRecipients' in raw) return notifyReport(req, res);
  if (raw && typeof raw === 'object' && 'quotaNotice' in raw) return notifyQuota(req, res);
  if (raw && typeof raw === 'object' && 'offerNotice' in raw) return notifyOffer(req, res);
  // An ecosystem notice names recipient RULES; a tenant email names an org.
  if (raw && typeof raw === 'object' && 'recipients' in raw) return notifyEcosystem(req, res);
  // The tenant-email shape is compliance's and reporting's. The plugin and quota
  // services each have their own leg, whose recipients platform resolves — the
  // tenant leg's `targetUsers` would let either name arbitrary members instead.
  if (serviceNameOf(req.user) === ECOSYSTEM_NOTICE_CALLER) {
    return sendError(res, 400, 'recipients is required for an ecosystem notice');
  }
  if (serviceNameOf(req.user) === QUOTA_NOTICE_CALLER) {
    return sendError(res, 400, 'quotaNotice is required for a quota notice');
  }
  // Billing reaches this relay ONLY for an offer. Without this it would fall
  // through to the tenant leg, whose `targetUsers` lets a caller name arbitrary
  // members — exactly the escalation the per-service legs exist to prevent.
  if (serviceNameOf(req.user) === OFFER_NOTICE_CALLER) {
    return sendError(res, 400, 'offerNotice is required for an offer notice');
  }
  const body = validateBody(notifyEmailSchema, req.body, res);
  if (!body) return;
  const { targetUsers } = body;

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
