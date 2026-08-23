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
