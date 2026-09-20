// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Platform's alert-notification channels.
 *
 * The channel CONTRACT (`NotificationMessage`, `ChannelTarget`,
 * `DeliveryResult`, `NotificationChannel`) and the webhook + email TRANSPORTS
 * now live in api-core (`services/notification-channels.ts`) — this file used to
 * carry its own fork of all of them, incompatible with compliance's fork down to
 * the field names. What is left here is genuinely platform-specific:
 *
 *  - the alert-shaped message extension (severity / status / labels) the Slack
 *    renderer needs, plus the shared plain-text body both in-app and email use;
 *  - the Slack payload renderer (a webhook transport with a bespoke body);
 *  - the `in-app` transport, which is the one transport that legitimately
 *    differs per service.
 *
 * LAYERING NOTE (verified, deliberate): the `in-app` channel writes the shared
 * `messages` table directly rather than calling the message service. That is an
 * intentional exception, not drift — platform is the Alertmanager ingress and a
 * single webhook can fan out to every org's destinations, so adding a
 * per-notification S2S hop to the message service would put an external
 * availability dependency on the alert path. The write goes through
 * `withTenantTx` under the caller's `runWithTenantContext({ isSuperAdmin: true })`,
 * so FORCE'd RLS on `messages` still governs it and the row is authored by the
 * system org exactly as the message service would author it. Compliance, which
 * is NOT on an alert path, keeps the HTTP transport.
 */

import {
  createChannelRegistry,
  createEmailChannel,
  createWebhookChannel,
  errorMessage,
  SYSTEM_ORG_ID,
  type ChannelTarget,
  type NotificationChannel,
  type NotificationMessage,
  type NotificationPriority,
} from '@pipeline-builder/api-core';
import { schema, withTenantTx } from '@pipeline-builder/pipeline-data';

import { config } from '../config/index.js';
import { emailService } from '../utils/email.js';

export type { ChannelTarget, NotificationPriority };
export type Severity = 'critical' | 'warning' | 'info';

/**
 * An alert rendered for delivery. Extends the shared transport-agnostic message
 * with the alert-shaped fields only the Slack renderer reads; `payload` carries
 * the exact Alertmanager body the generic `webhook` channel forwards unchanged.
 */
export interface AlertNotification extends NotificationMessage {
  severity: Severity;
  status: 'firing' | 'resolved';
  /** When the underlying event started (ISO-8601). Shown as "Started: …". */
  timestamp: string;
  /** Short alert name; `subject` is this prefixed with `[SEV]`. */
  title: string;
  /** One-line summary (annotations.summary). */
  summary: string;
  /** Optional longer detail (annotations.description). */
  detail?: string;
  /** Full label map; channels filter the noisy keys themselves. */
  labels: Record<string, string>;
}

// -- Shared rendering ---------------------------------------------------------

/** Alert severity → inbox priority. */
export const severityToPriority = (s: Severity): NotificationPriority =>
  s === 'critical' ? 'urgent' : s === 'warning' ? 'high' : 'normal';

const severityToColor = (s: Severity): string =>
  s === 'critical' ? '#dc2626' : s === 'warning' ? '#eab308' : '#3b82f6';

export const subjectLine = (a: Pick<AlertNotification, 'severity' | 'title'>): string =>
  `[${a.severity.toUpperCase()}] ${a.title}`;

/**
 * Plain-text body shared by the in-app and email channels: summary, optional
 * detail, the non-noise labels as `key=value`, then a status/started footer.
 */
export function plainTextBody(a: Pick<AlertNotification, 'summary' | 'detail' | 'labels' | 'status' | 'timestamp'>): string {
  const lines: string[] = [];
  if (a.summary) lines.push(a.summary);
  if (a.detail) lines.push('', a.detail);
  const extraLabels = Object.entries(a.labels)
    .filter(([k]) => !['alertname', 'severity', 'tenancy', 'org_id'].includes(k))
    .map(([k, v]) => `${k}=${v}`);
  if (extraLabels.length > 0) lines.push('', extraLabels.join(' '));
  lines.push('', `Status: ${a.status} · Started: ${a.timestamp}`);
  return lines.join('\n');
}

// -- Slack --------------------------------------------------------------------

/** Slack incoming-webhook payload. Color matches severity so on-call eyeballs
 *  find critical alerts faster; emoji reflects firing vs resolved. */
function slackPayload(msg: AlertNotification): Record<string, unknown> {
  const emoji = msg.status === 'resolved' ? '✅' : msg.severity === 'critical' ? '🚨' : '⚠️';
  return {
    attachments: [{
      color: severityToColor(msg.severity),
      title: `${emoji} ${subjectLine(msg)}`,
      text: msg.summary,
      fields: [
        ...(msg.detail ? [{ title: 'Detail', value: msg.detail, short: false }] : []),
        ...Object.entries(msg.labels)
          .filter(([k]) => !['alertname', 'severity', 'tenancy'].includes(k))
          .map(([k, v]) => ({ title: k, value: v, short: true })),
        { title: 'Status', value: msg.status, short: true },
        { title: 'Started', value: msg.timestamp, short: true },
      ],
      footer: 'Pipeline Builder alerts',
    }],
  };
}

/**
 * Slack is a webhook with a bespoke body — so it is the SHARED webhook transport
 * with a renderer, which also closes a real hole: the old bespoke `fetch` here
 * ran NO SSRF guard at all (the target is org-supplied and only allowlisted by
 * hostname at create time), so it neither pinned the resolved address nor
 * refused redirects.
 */
const slackChannel = createWebhookChannel<AlertNotification>({ name: 'slack', render: slackPayload });

// -- Generic webhook ----------------------------------------------------------

const webhookChannel = createWebhookChannel<AlertNotification>();

// -- In-app inbox -------------------------------------------------------------

const inAppChannel: NotificationChannel<AlertNotification> = {
  channel: 'in-app',
  // No network target — appends a row to the recipient org's `messages` inbox.
  // Authored by the system org; priority maps from severity. The caller runs
  // this under `runWithTenantContext({ isSuperAdmin: true })` so the cross-org
  // write passes FORCE'd RLS on `messages`. See the layering note at the top.
  async deliver(msg) {
    try {
      await withTenantTx(async (tx) => tx.insert(schema.message).values({
        orgId: SYSTEM_ORG_ID,
        recipientOrgId: msg.recipientOrgId,
        createdBy: 'alert-relay',
        updatedBy: 'alert-relay',
        messageType: msg.messageType,
        subject: msg.subject,
        content: msg.body,
        priority: msg.priority,
      }));
      return { ok: true };
    } catch (err) {
      return { ok: false, error: errorMessage(err) };
    }
  },
};

// -- Email --------------------------------------------------------------------

/** At-least-once dedupe window for email. Alertmanager retries the webhook, so
 *  an identical (alert, recipient) email inside this window is suppressed. */
const emailChannel = createEmailChannel<AlertNotification>({
  enabled: () => config.email.enabled,
  dedupeTtlMs: config.observability.alertEmailDedupeTtlMs,
  send: (req) => emailService.send({ to: req.to ?? '', subject: req.subject, text: req.text }),
});

// -- Factory ------------------------------------------------------------------

/** Resolve the channel adapter for a destination's `channel`, or null if the
 *  value isn't a known channel (it's DB data, so an unknown value is possible
 *  — the caller logs + counts it rather than throwing). */
export const getNotificationChannel = createChannelRegistry<AlertNotification>([
  slackChannel,
  webhookChannel,
  inAppChannel,
  emailChannel,
]);
