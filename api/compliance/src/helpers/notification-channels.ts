// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Compliance notification channels.
 *
 * The channel CONTRACT and the webhook + email TRANSPORTS live in api-core
 * (`services/notification-channels.ts`), shared with platform.
 *
 * What is left here is the ONE transport that legitimately differs per service:
 * `in-app`. Compliance sends a system notification through the message
 * service (platform, which is the Alertmanager ingress, writes the shared table
 * directly — see the layering note in platform's copy).
 */

import {
  createChannelRegistry,
  createEmailChannel,
  createWebhookChannel,
  getServiceAuthHeader,
  sendSystemNotification,
  type ChannelTarget,
  type NotificationChannel,
  type NotificationMessage,
  type NotificationPriority,
} from '@pipeline-builder/api-core';

import { emailClient } from './email-client.js';

export type { ChannelTarget, NotificationMessage, NotificationPriority };

const inAppChannel: NotificationChannel = {
  channel: 'in-app',
  async deliver(n) {
    // A SYSTEM-authored message into the recipient org's inbox, via the message
    // service's internal notify route. Reported as sent only on a 2xx — a
    // refusal must not be logged as a delivered notification.
    const delivered = await sendSystemNotification({
      recipientOrgId: n.recipientOrgId,
      subject: n.subject,
      content: n.body,
      priority: n.priority,
    });
    return delivered ? { ok: true } : { ok: false, error: 'message service did not accept the notification' };
  },
};

/**
 * Org-configured webhook (`complianceNotificationPreference.webhookUrl`), HMAC-
 * signed when a `webhookSecret` is set. https-only, resolved-and-PINNED, and
 * redirects refused — all of that is api-core's shared transport now.
 */
const webhookChannel = createWebhookChannel();

/**
 * Platform resolves recipients (targetUsers, or all org admins when null) and
 * sends via its EmailService — compliance has no SMTP/SES of its own.
 */
const emailChannel = createEmailChannel({
  send: async (req) => {
    // The client resolves (not throws) on a 4xx/5xx, so the status is the only
    // signal that platform refused or failed the send.
    const resp = await emailClient.post('/internal/notify-email', {
      orgId: req.orgId,
      targetUsers: req.targetUsers ?? null,
      subject: req.subject,
      text: req.text,
    }, {
      headers: {
        // Scoped to the TENANT the email is for: platform's relay is tenant-bound
        // (a non-superadmin service token may only email its own org's users),
        // so a system-org token naming a tenant `orgId` is refused 403.
        Authorization: getServiceAuthHeader({ serviceName: 'compliance', orgId: req.orgId, role: 'member' }),
      },
    });
    return resp.statusCode < 400;
  },
});

/** Resolve a channel adapter by name, or null for an unknown channel. */
export const getNotificationChannel = createChannelRegistry([
  inAppChannel,
  webhookChannel,
  emailChannel,
]);

export { inAppChannel, webhookChannel };
