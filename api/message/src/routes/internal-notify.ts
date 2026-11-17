// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { MESSAGE_INTERNAL, SYSTEM_ACTOR_ID, sendSuccess, sendError, sendBadRequest, ErrorCode, createLogger, errorMessage, requireAuth, requireInternalService, SYSTEM_ORG_ID, audited, recordAudit, serviceNameOf, contractErrorMessage, contractRoute, notifyBodyErrorCode, parseContractBody } from '@pipeline-builder/api-core';
import { incCounter } from '@pipeline-builder/api-server';
import type { SSEManager } from '@pipeline-builder/api-server';
import { runWithTenantContext, type MessageInsert } from '@pipeline-builder/pipeline-data';
import { Router } from 'express';
import type { Request, Response } from 'express';
import { notifyNewMessage } from '../helpers/new-message.js';
import { messageService } from '../services/message-service.js';

const logger = createLogger('internal-notify');

/** The route, its callers and its body schema — defined once in api-core. */
const NOTIFY = MESSAGE_INTERNAL.notify;

/**
 * Internal notification route (service-to-service only).
 *
 * Lets a trusted service drop a SYSTEM-authored in-app message into a
 * recipient org's inbox (optionally targeted to one user) and push the SSE ping,
 * WITHOUT a user session. Callers use api-core's `sendSystemNotification`:
 * platform (domain-join, impersonation, SCIM notices), billing (renewal
 * reminders), compliance (the in-app notification channel), quota (the
 * usage-threshold notifier's "approaching / reached your limit" notices) and
 * reporting (stakeholder-report delivery's in-app notices).
 *
 * Gated by `requireAuth` + `requireInternalService` — a signed service token
 * from one of those callers, never a user session, mirroring the internal
 * org-purge route. The mesh policy on the targets that
 * run Istio names the same callers; compose has no mesh, so this gate is the
 * whole enforcement there.
 *
 * The insert runs inside an EXPLICIT system tenant scope (`isSuperAdmin: true`):
 * the caller's service token is scoped to `recipientOrgId`, so without this the
 * CRUD layer's `enforceOrgId` would rewrite the row's `orgId` from SYSTEM to the
 * recipient org — mis-attributing the message AND (via the sender-org read
 * branch) exposing a targeted DM to every member of the recipient org. The
 * explicit scope also makes the write self-contained rather than relying on the
 * tenant context bled in by earlier `/messages` middleware.
 *
 * Audited as `message.notify.internal` (system actor, calling service in
 * `details.caller`): the calling service audits the event it notifies ABOUT,
 * but only this route knows a message actually landed in the recipient's inbox.
 * Metadata only — the subject and body never reach the trail.
 *
 * Registers: POST /internal/notify → { id } (api-core `MESSAGE_INTERNAL.notify`)
 */
export function createInternalNotifyRoutes(sseManager: SSEManager): Router {
  const router = Router();

  router.post(contractRoute(NOTIFY, '/messages'), requireAuth, requireInternalService({ callers: NOTIFY.callers }), audited('message.notify.internal'), async (req: Request, res: Response) => {
    // The contract's schema reads each field as a trimmed string or not at all,
    // drops an empty `recipientUserId` (no target, not a target nobody holds),
    // lower-cases the recipient, and reports the first failing rule with the
    // error code this route has always answered.
    const parsed = parseContractBody(NOTIFY, req);
    if (!parsed.ok) {
      return sendBadRequest(res, contractErrorMessage(parsed), ErrorCode[notifyBodyErrorCode(parsed.zodError)]);
    }
    const { recipientOrgId: recipient, recipientUserId, subject, content, priority } = parsed.value;

    try {
      const data: MessageInsert = {
        orgId: SYSTEM_ORG_ID, // system is the sender (kept by the system scope below)
        recipientOrgId: recipient,
        recipientUserId: recipientUserId ?? null,
        messageType: 'conversation',
        channel: 'notifications',
        subject,
        content,
        ...(priority ? { priority } : {}),
        createdBy: SYSTEM_ACTOR_ID,
        updatedBy: SYSTEM_ACTOR_ID,
      };
      // Author as the system tenant (isSuperAdmin → enforceOrgId is a no-op), not
      // the recipient-org scope the service token carries. See the class doc.
      const message = await runWithTenantContext(
        { orgId: SYSTEM_ORG_ID, isSuperAdmin: true },
        () => messageService.create(data, SYSTEM_ACTOR_ID),
      );
      incCounter('message_events_total', { action: 'created' });

      // Real-time ping (org-scoped fan-out; subject redacted for a targeted DM) —
      // the same notifier create-message uses.
      notifyNewMessage(sseManager, {
        recipientOrgId: recipient,
        messageId: message.id,
        subject,
        targeted: !!recipientUserId,
        senderOrgId: SYSTEM_ORG_ID,
        messageType: 'conversation',
      }, (err) => logger.warn('SSE push failed', { error: errorMessage(err) }));

      recordAudit({
        action: 'message.notify.internal',
        actorId: SYSTEM_ACTOR_ID,
        orgId: SYSTEM_ORG_ID,
        affectedOrgId: recipient,
        targetType: 'message',
        targetId: message.id,
        details: {
          caller: serviceNameOf(req.user) ?? 'unknown',
          targeted: !!recipientUserId,
          priority: priority ?? null,
        },
      });

      logger.info('Internal notification sent', { recipientOrgId: recipient, id: message.id, targeted: !!recipientUserId });
      return sendSuccess(res, 201, { id: message.id });
    } catch (err) {
      logger.warn('Internal notify failed', { error: errorMessage(err) });
      return sendError(res, 500, 'Failed to create notification', ErrorCode.INTERNAL_ERROR);
    }
  });

  return router;
}
