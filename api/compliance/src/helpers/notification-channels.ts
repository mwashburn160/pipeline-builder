// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Compliance notification channels — one adapter per delivery transport, behind
 * a factory. Mirrors the platform alert-relay channel pattern, kept local to the
 * compliance service (the two services share the shape, not the implementations:
 * compliance's `in-app` is an HTTP call to the message service, platform's is a
 * direct `messages` insert).
 *
 * `in-app` posts to the message-service inbox (the only transport compliance had
 * before). `webhook` POSTs the structured payload to the org's configured
 * `webhookUrl`, HMAC-signed when a `webhookSecret` is set — finally activating
 * the `complianceNotificationPreference.webhookUrl`/`webhookSecret` columns.
 *
 * No pipeline-core/DB import here on purpose, so the channels stay trivially
 * mockable; the preference read + audit-log write live in notification-service.
 */

import { createHmac } from 'crypto';

import { errorMessage, getServiceAuthHeader } from '@pipeline-builder/api-core';

import { emailClient } from './email-client.js';
import { messageClient } from './message-client.js';

export type MessagePriority = 'urgent' | 'high' | 'normal';

/** Transport-agnostic compliance notification. */
export interface ComplianceNotification {
  recipientOrgId: string;
  subject: string;
  content: string;
  priority: MessagePriority;
  messageType: 'announcement' | 'conversation';
  /** Structured body for the webhook channel and the audit-log payload. */
  payload: Record<string, unknown>;
}

/** Channel-specific target. `url`/`secret` are used by the webhook channel only;
 *  `targetUsers` by the email channel (null/absent = all org admins). */
export interface ChannelTarget {
  url?: string;
  secret?: string;
  targetUsers?: string[] | null;
}

export interface DeliveryResult {
  ok: boolean;
  code?: number;
  error?: string;
}

export interface NotificationChannel {
  readonly channel: 'in-app' | 'webhook' | 'email';
  deliver(n: ComplianceNotification, target: ChannelTarget, signal?: AbortSignal): Promise<DeliveryResult>;
}

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
        content: n.content,
        priority: n.priority,
      }, {
        headers: {
          'Authorization': getServiceAuthHeader({ serviceName: 'compliance', orgId: 'system', role: 'member' }),
          'x-org-id': 'system',
          'x-internal-service': 'true',
        },
      });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: errorMessage(err) };
    }
  },
};

const webhookChannel: NotificationChannel = {
  channel: 'webhook',
  async deliver(n, target, signal) {
    if (!target.url) return { ok: false, error: 'no webhook url' };
    const body = JSON.stringify(n.payload);
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    // Sign when a secret is configured so the receiver can verify authenticity.
    if (target.secret) {
      headers['X-PB-Signature'] = `sha256=${createHmac('sha256', target.secret).update(body).digest('hex')}`;
    }
    const resp = await fetch(target.url, { method: 'POST', signal, headers, body });
    return resp.ok ? { ok: true, code: resp.status } : { ok: false, code: resp.status };
  },
};

const emailChannel: NotificationChannel = {
  channel: 'email',
  async deliver(n, target) {
    // Platform resolves recipients (targetUsers, or all org admins when null)
    // and sends via its EmailService — compliance has no SMTP/SES of its own.
    try {
      await emailClient.post('/internal/notify-email', {
        orgId: n.recipientOrgId,
        targetUsers: target.targetUsers ?? null,
        subject: n.subject,
        text: n.content,
      }, {
        headers: {
          'Authorization': getServiceAuthHeader({ serviceName: 'compliance', orgId: 'system', role: 'member' }),
          'x-internal-service': 'true',
        },
      });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: errorMessage(err) };
    }
  },
};

const CHANNELS: Record<string, NotificationChannel> = {
  'in-app': inAppChannel,
  'webhook': webhookChannel,
  'email': emailChannel,
};

/** Resolve a channel adapter by name, or null for an unknown channel. */
export function getNotificationChannel(channel: string): NotificationChannel | null {
  return CHANNELS[channel] ?? null;
}

export { inAppChannel, webhookChannel };
