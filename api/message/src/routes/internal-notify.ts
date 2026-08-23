// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { sendSuccess, sendError, sendBadRequest, ErrorCode, createLogger, errorMessage, requireAuth, requireServicePrincipal, AccessModifier, SYSTEM_ORG_ID } from '@pipeline-builder/api-core';
import { incCounter } from '@pipeline-builder/api-server';
import type { SSEManager } from '@pipeline-builder/api-server';
import { runWithTenantContext, type MessageInsert } from '@pipeline-builder/pipeline-data';
import { Router } from 'express';
import type { Request, Response } from 'express';
import { messageService } from '../services/message-service.js';

const logger = createLogger('internal-notify');

const SUBJECT_MAX = 500;   // matches the `subject` varchar(500) column
const CONTENT_MAX = 10000; // sane bound for a notification body (content is TEXT)

/**
 * Internal notification route (service-to-service only).
 *
 * Lets a trusted platform service drop a SYSTEM-authored in-app message into a
 * recipient org's inbox (optionally targeted to one user) and push the SSE ping,
 * WITHOUT a user session. Used by the domain-based-join flow to notify org
 * admins of a new join request and the requester of the decision.
 *
 * Gated by `requireAuth` + `requireServicePrincipal` — a signed service token,
 * never a user session — mirroring the internal org-purge route.
 *
 * The insert runs inside an EXPLICIT system tenant scope (`isSuperAdmin: true`):
 * the caller's service token is scoped to `recipientOrgId`, so without this the
 * CRUD layer's `enforceOrgId` would rewrite the row's `orgId` from SYSTEM to the
 * recipient org — mis-attributing the message AND (via the sender-org read
 * branch) exposing a targeted DM to every member of the recipient org. The
 * explicit scope also makes the write self-contained rather than relying on the
 * tenant context bled in by earlier `/messages` middleware.
 *
 * Registers: POST /internal/notify → { id }
 */
export function createInternalNotifyRoutes(sseManager: SSEManager): Router {
  const router = Router();

  router.post('/internal/notify', requireAuth, requireServicePrincipal, async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as { recipientOrgId?: string; recipientUserId?: string; subject?: string; content?: string };
    const recipientUserId = body.recipientUserId;
    const subject = body.subject?.trim();
    const content = body.content?.trim();
    const recipient = body.recipientOrgId?.trim().toLowerCase();

    if (!recipient || !subject || !content) {
      return sendBadRequest(res, 'recipientOrgId, subject and content are required', ErrorCode.MISSING_REQUIRED_FIELD);
    }
    // '*' is the announcement-broadcast recipient — a notification is a concrete DM.
    if (recipient === '*') {
      return sendBadRequest(res, 'recipientOrgId "*" is reserved for announcements', ErrorCode.VALIDATION_ERROR);
    }
    if (subject.length > SUBJECT_MAX || content.length > CONTENT_MAX) {
      return sendBadRequest(res, 'subject or content exceeds the maximum length', ErrorCode.VALIDATION_ERROR);
    }

    try {
      const data: MessageInsert = {
        orgId: SYSTEM_ORG_ID,          // system is the sender (kept by the system scope below)
        recipientOrgId: recipient,
        recipientUserId: recipientUserId ?? null,
        messageType: 'conversation',
        channel: 'notifications',
        subject,
        content,
        createdBy: 'system',
        updatedBy: 'system',
        accessModifier: AccessModifier.PRIVATE,
      };
      // Author as the system tenant (isSuperAdmin → enforceOrgId is a no-op), not
      // the recipient-org scope the service token carries. See the class doc.
      const message = await runWithTenantContext(
        { orgId: SYSTEM_ORG_ID, isSuperAdmin: true },
        () => messageService.create(data, 'system'),
      );
      incCounter('message_events_total', { action: 'created' });

      // Real-time ping (org-scoped fan-out). Redact the subject for a targeted DM
      // so it doesn't leak to org members who can't read it — mirrors create-message.
      try {
        sseManager.send(recipient, 'MESSAGE', 'New message', {
          action: 'NEW_MESSAGE',
          messageId: message.id,
          subject: recipientUserId ? undefined : subject,
          senderOrgId: SYSTEM_ORG_ID,
          messageType: 'conversation',
        });
      } catch (err) {
        logger.warn('SSE push failed', { error: errorMessage(err) });
      }

      logger.info('Internal notification sent', { recipientOrgId: recipient, id: message.id, targeted: !!recipientUserId });
      return sendSuccess(res, 201, { id: message.id });
    } catch (err) {
      logger.warn('Internal notify failed', { error: errorMessage(err) });
      return sendError(res, 500, 'Failed to create notification', ErrorCode.INTERNAL_ERROR);
    }
  });

  return router;
}
