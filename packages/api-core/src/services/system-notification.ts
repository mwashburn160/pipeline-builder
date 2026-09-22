// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createSafeClient } from './http-client.js';
import { serviceIdentity } from './service-keys.js';
import { getServiceAuthHeader } from '../middleware/service-tokens.js';
import type { ServiceConfig } from '../types/common.js';
import type { MessagePriority } from '../types/wire-vocabulary.js';
import { createLogger } from '../utils/logger.js';
import { errorMessage } from '../utils/response.js';
import { serviceEndpoint } from '../utils/service-registry.js';

const logger = createLogger('system-notification');

/** The message service's service-to-service notification route. */
export const SYSTEM_NOTIFY_PATH = '/messages/internal/notify';

/** A SYSTEM-authored in-app message for a recipient org, optionally one user. */
export interface SystemNotification {
  recipientOrgId: string;
  recipientUserId?: string;
  subject: string;
  content: string;
  priority?: MessagePriority;
}

/**
 * Drop a SYSTEM-authored message into a recipient org's inbox via the message
 * service's internal notify route (which also pushes the real-time SSE ping).
 * Authenticates with this process's signed service token, scoped to the
 * recipient org.
 *
 * REPORTS whether the message was persisted: true only on a 2xx. Never throws —
 * an unreachable service or a refusal is logged and returns false, so a caller
 * whose non-delivery costs something (a retried reminder, a notification log)
 * can act on it.
 */
export async function sendSystemNotification(
  notification: SystemNotification,
  opts: { service?: ServiceConfig; serviceName?: string } = {},
): Promise<boolean> {
  try {
    const client = createSafeClient(opts.service ?? serviceEndpoint('message'));
    const result = await client.post(SYSTEM_NOTIFY_PATH, notification, {
      headers: {
        authorization: getServiceAuthHeader({
          serviceName: opts.serviceName ?? serviceIdentity(),
          orgId: notification.recipientOrgId,
          role: 'member',
        }),
      },
    });
    // The safe client resolves null on a transport failure rather than throwing.
    if (result === null || result.statusCode < 200 || result.statusCode >= 300) {
      logger.warn('System notification not delivered', {
        recipientOrgId: notification.recipientOrgId,
        statusCode: result?.statusCode ?? 'unreachable',
      });
      return false;
    }
    return true;
  } catch (err) {
    logger.warn('System notification failed', { recipientOrgId: notification.recipientOrgId, error: errorMessage(err) });
    return false;
  }
}
