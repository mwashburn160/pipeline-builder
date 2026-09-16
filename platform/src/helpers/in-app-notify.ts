// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createLogger, createSafeClient, getServiceAuthHeader } from '@pipeline-builder/api-core';
import { config } from '../config/index.js';

const logger = createLogger('in-app-notify');

/**
 * Post a SYSTEM-authored in-app message to a recipient org (optionally targeted
 * to one user) via the message service's service-to-service internal endpoint,
 * which persists it to the recipient's inbox and pushes the real-time SSE ping.
 *
 * Fire-and-forget by contract: never throws (callers `void` it). No-op when the
 * message service is disabled. Auth is a signed platform service token, matching
 * the org-purge cascade's call into the same service.
 */
export async function sendInAppNotification(input: {
  recipientOrgId: string;
  recipientUserId?: string;
  subject: string;
  content: string;
}): Promise<void> {
  if (!config.message.enabled) return;
  try {
    const client = createSafeClient({
      host: config.message.serviceHost,
      port: config.message.servicePort,
      timeout: config.message.serviceTimeout,
    });
    await client.post('/messages/internal/notify', input, {
      headers: {
        authorization: getServiceAuthHeader({ serviceName: 'platform', orgId: input.recipientOrgId, role: 'member' }),
      },
    });
  } catch (err) {
    logger.warn('In-app notification failed (non-blocking)', { recipientOrgId: input.recipientOrgId, error: String(err) });
  }
}

/**
 * Like {@link sendInAppNotification}, but REPORTS whether the message was
 * persisted instead of swallowing the outcome.
 *
 * For a message whose non-delivery costs something. The fire-and-forget variant
 * above is right for a courtesy notice; it is wrong for an impersonation
 * CHALLENGE, where a dropped message becomes a silent expiry that reads as a
 * refusal. Delivery is in-app only, with no email fallback, so the caller must
 * know when this failed in order to mark the request undeliverable.
 *
 * Never throws. Returns false when the message service is disabled — with no
 * other channel, a disabled service means nobody can be asked.
 */
export async function sendInAppNotificationConfirmed(input: {
  recipientOrgId: string;
  recipientUserId?: string;
  subject: string;
  content: string;
}): Promise<boolean> {
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
    return result !== null && result.statusCode >= 200 && result.statusCode < 300;
  } catch (err) {
    logger.warn('Confirmed in-app notification failed', { recipientOrgId: input.recipientOrgId, error: String(err) });
    return false;
  }
}
