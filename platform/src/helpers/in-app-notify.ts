// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createLogger, createSafeClient, getServiceAuthHeader } from '@pipeline-builder/api-core';
import { config } from '../config/index.js';

const logger = createLogger('in-app-notify');

/** A SYSTEM-authored in-app message for a recipient org, optionally one user. */
export interface InAppNotification {
  recipientOrgId: string;
  recipientUserId?: string;
  subject: string;
  content: string;
}

/**
 * Post a SYSTEM-authored in-app message via the message service's
 * service-to-service internal endpoint, which persists it to the recipient's
 * inbox and pushes the real-time SSE ping. REPORTS whether it was persisted.
 *
 * For a message whose non-delivery costs something — e.g. an impersonation
 * CHALLENGE, where a dropped message becomes a silent expiry that reads as a
 * refusal. Delivery is in-app only, with no email fallback, so the caller must
 * know when this failed.
 *
 * Never throws; every failed delivery (unreachable, non-2xx, error) is logged.
 * Returns false when the message service is disabled — with no other channel, a
 * disabled service means nobody can be reached. Auth is a signed platform
 * service token, matching the org-purge cascade's call into the same service.
 */
export async function sendInAppNotificationConfirmed(input: InAppNotification): Promise<boolean> {
  if (!config.message.enabled) return false;
  try {
    const client = createSafeClient({
      host: config.message.serviceHost,
      port: config.message.servicePort,
      timeout: config.message.serviceTimeout,
    });
    const result = await client.post('/messages/internal/notify', input, {
      headers: {
        authorization: getServiceAuthHeader({ serviceName: 'platform', orgId: input.recipientOrgId, role: 'member' }),
      },
    });
    // `createSafeClient` resolves null on a transport failure rather than
    // throwing, so a missing result is a failed delivery, not a success.
    if (result === null || result.statusCode < 200 || result.statusCode >= 300) {
      logger.warn('In-app notification not delivered', {
        recipientOrgId: input.recipientOrgId,
        statusCode: result?.statusCode ?? 'unreachable',
      });
      return false;
    }
    return true;
  } catch (err) {
    logger.warn('In-app notification failed', { recipientOrgId: input.recipientOrgId, error: String(err) });
    return false;
  }
}

/**
 * Fire-and-forget {@link sendInAppNotificationConfirmed}, for a courtesy notice
 * whose loss costs nothing. Never throws (callers `void` it); failures are
 * logged by the confirmed variant.
 */
export async function sendInAppNotification(input: InAppNotification): Promise<void> {
  await sendInAppNotificationConfirmed(input);
}
