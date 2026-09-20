// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Compliance notification channels.
 *
 * The channel CONTRACT and the webhook + email TRANSPORTS now live in api-core
 * (`services/notification-channels.ts`). This file used to carry a full fork of
 * both, incompatible with platform's fork down to the field names (`target.url`
 * vs `target.value`, a priority enum vs a severity enum, no `skipped` in the
 * result). The pinned-connection SSRF posture this file pioneered was the better
 * of the two and is what api-core's `safeFetch` now does for everyone.
 *
 * What is left here is the ONE transport that legitimately differs per service:
 * `in-app`. Compliance posts to the message service over HTTP (platform, which
 * is the Alertmanager ingress, writes the shared table directly — see the
 * layering note in platform's copy).
 */

import {
  createChannelRegistry,
  createEmailChannel,
  createWebhookChannel,
  errorMessage,
  getServiceAuthHeader,
  SYSTEM_ORG_ID,
  type ChannelTarget,
  type NotificationChannel,
  type NotificationMessage,
  type NotificationPriority,
} from '@pipeline-builder/api-core';

import { emailClient } from './email-client.js';
import { messageClient } from './message-client.js';

export type { ChannelTarget, NotificationMessage, NotificationPriority };

const inAppChannel: NotificationChannel = {
  channel: 'in-app',
  async deliver(n) {
    // Authored by the system org (cross-tenant write to the message service);
    // the recipient org's inbox surfaces it. Always a service-minted token —
    // the originating user's bearer can't write across tenants.
    try {
      await messageClient.post('/messages', {
        recipientOrgId: n.recipientOrgId,
        messageType: n.messageType,
        subject: n.subject,
        content: n.body,
        priority: n.priority,
      }, {
        headers: {
          'Authorization': getServiceAuthHeader({ serviceName: 'compliance', orgId: SYSTEM_ORG_ID, role: 'member' }),
          'x-org-id': SYSTEM_ORG_ID,
        },
      });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: errorMessage(err) };
    }
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
    await emailClient.post('/internal/notify-email', {
      orgId: req.orgId,
      targetUsers: req.targetUsers ?? null,
      subject: req.subject,
      text: req.text,
    }, {
      headers: {
        Authorization: getServiceAuthHeader({ serviceName: 'compliance', orgId: SYSTEM_ORG_ID, role: 'member' }),
      },
    });
    return true;
  },
});

/** Resolve a channel adapter by name, or null for an unknown channel. */
export const getNotificationChannel = createChannelRegistry([
  inAppChannel,
  webhookChannel,
  emailChannel,
]);

export { inAppChannel, webhookChannel };
