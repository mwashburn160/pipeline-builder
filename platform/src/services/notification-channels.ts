// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Notification channels — one adapter per delivery transport, behind a factory.
 *
 * Collapses the per-channel `if (channel === 'slack') … 'webhook' … 'in-app'`
 * branching that used to live inline in alert-relay's `deliverOne`. Each channel
 * owns only its own transport (Slack block payload, raw webhook POST, `messages`
 * inbox row, email). The CALLER owns the cross-cutting concerns — the per-delivery
 * AbortController/timeout (passed in as `signal`) and the success/failure counting.
 *
 * The contract is transport-agnostic on purpose: a `NotificationMessage` carries
 * the structured fields every channel renders from, plus `raw` (the exact JSON
 * body the generic `webhook` channel forwards unchanged) so existing webhook
 * consumers keep receiving the Alertmanager alert shape. Kept local to `platform`
 * for now; promote to a shared package only when a second service needs it.
 */

import { createHmac } from 'crypto';

import { errorMessage, SYSTEM_ORG_ID } from '@pipeline-builder/api-core';
import { schema, withTenantTx } from '@pipeline-builder/pipeline-data';

import { config } from '../config/index.js';
import { emailService } from '../utils/email.js';

export type Severity = 'critical' | 'warning' | 'info';

/** Transport-agnostic notification payload. Channels render from these fields. */
export interface NotificationMessage {
  severity: Severity;
  status: 'firing' | 'resolved';
  /** When the underlying event started (ISO-8601). Shown as "Started: …". */
  timestamp: string;
  /** Short subject line (e.g. the alertname). Channels prefix it with `[SEV]`. */
  title: string;
  /** One-line summary (annotations.summary). */
  summary: string;
  /** Optional longer detail (annotations.description). */
  detail?: string;
  /** Full label map; channels filter the noisy keys themselves. */
  labels: Record<string, string>;
  recipientOrgId: string;
  /** Exact JSON body for the generic `webhook` channel (forwarded unchanged). */
  raw: unknown;
  /** Stable key for at-least-once channels (email) to dedupe retries. */
  dedupeKey?: string;
}

/** Channel-specific delivery target. `value` = URL or email; `secret` = HMAC key. */
export interface ChannelTarget {
  value: string;
  secret?: string;
  orgId: string;
}

/**
 * Outcome of one delivery. `skipped` distinguishes "intentionally not sent"
 * (email disabled, dedupe hit) from a real failure — the caller counts them
 * apart. `code`/`error` feed structured logging (and, later, an audit log).
 */
export interface DeliveryResult {
  ok: boolean;
  skipped?: boolean;
  code?: number;
  error?: string;
}

export interface NotificationChannel {
  readonly channel: string;
  deliver(msg: NotificationMessage, target: ChannelTarget, signal: AbortSignal): Promise<DeliveryResult>;
}

// -- Shared severity mappings (used by more than one channel) -----------------

const severityToPriority = (s: Severity): 'urgent' | 'high' | 'normal' =>
  s === 'critical' ? 'urgent' : s === 'warning' ? 'high' : 'normal';

const severityToColor = (s: Severity): string =>
  s === 'critical' ? '#dc2626' : s === 'warning' ? '#eab308' : '#3b82f6';

/**
 * Plain-text body shared by the in-app and email channels: summary, optional
 * detail, the non-noise labels as `key=value`, then a status/started footer.
 */
function plainTextBody(msg: NotificationMessage): string {
  const lines: string[] = [];
  if (msg.summary) lines.push(msg.summary);
  if (msg.detail) lines.push('', msg.detail);
  const extraLabels = Object.entries(msg.labels)
    .filter(([k]) => !['alertname', 'severity', 'tenancy', 'org_id'].includes(k))
    .map(([k, v]) => `${k}=${v}`);
  if (extraLabels.length > 0) lines.push('', extraLabels.join(' '));
  lines.push('', `Status: ${msg.status} · Started: ${msg.timestamp}`);
  return lines.join('\n');
}

const subjectLine = (msg: NotificationMessage): string =>
  `[${msg.severity.toUpperCase()}] ${msg.title}`;

// -- Slack --------------------------------------------------------------------

/** Slack incoming-webhook payload. Color matches severity so on-call eyeballs
 *  find critical alerts faster; emoji reflects firing vs resolved. */
function slackPayload(msg: NotificationMessage): Record<string, unknown> {
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

const slackChannel: NotificationChannel = {
  channel: 'slack',
  async deliver(msg, target, signal) {
    const resp = await fetch(target.value, {
      method: 'POST',
      signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(slackPayload(msg)),
    });
    return resp.ok ? { ok: true, code: resp.status } : { ok: false, code: resp.status };
  },
};

// -- Generic webhook ----------------------------------------------------------

const webhookChannel: NotificationChannel = {
  channel: 'webhook',
  async deliver(msg, target, signal) {
    // Forward the canonical payload unchanged (the Alertmanager alert shape for
    // alert relays). HMAC-sign only when the target carries a secret — alert
    // destinations don't, so they stay unsigned exactly as before; future
    // consumers (e.g. compliance) can opt in by supplying `target.secret`.
    const body = JSON.stringify(msg.raw);
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (target.secret) {
      headers['X-PB-Signature'] = `sha256=${createHmac('sha256', target.secret).update(body).digest('hex')}`;
    }
    const resp = await fetch(target.value, { method: 'POST', signal, headers, body });
    return resp.ok ? { ok: true, code: resp.status } : { ok: false, code: resp.status };
  },
};

// -- In-app inbox -------------------------------------------------------------

const inAppChannel: NotificationChannel = {
  channel: 'in-app',
  // No network target — appends a row to the recipient org's `messages` inbox.
  // Authored by the system org; priority maps from severity. The caller runs
  // this under `runWithTenantContext({ isSuperAdmin: true })` so the cross-org
  // write passes FORCE'd RLS on `messages`.
  async deliver(msg) {
    try {
      await withTenantTx(async (tx) => tx.insert(schema.message).values({
        orgId: SYSTEM_ORG_ID,
        recipientOrgId: msg.recipientOrgId,
        createdBy: 'alert-relay',
        updatedBy: 'alert-relay',
        messageType: 'announcement',
        subject: subjectLine(msg),
        content: plainTextBody(msg),
        priority: severityToPriority(msg.severity),
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
const EMAIL_DEDUPE_TTL_MS = parseInt(process.env.ALERT_EMAIL_DEDUPE_TTL_MS || '600000', 10);
const recentEmails = new Map<string, number>(); // dedupe key -> expiry (epoch ms)

function emailSeenRecently(key: string): boolean {
  const now = Date.now();
  for (const [k, exp] of recentEmails) {
    if (exp <= now) recentEmails.delete(k);
  }
  return recentEmails.has(key);
}

const emailChannel: NotificationChannel = {
  channel: 'email',
  async deliver(msg, target) {
    // Email disabled on this deploy → report skipped (NOT delivered) so the
    // relay never claims it sent something it didn't.
    if (!config.email.enabled) {
      return { ok: false, skipped: true, error: 'email-disabled' };
    }
    const dedupeKey = msg.dedupeKey ? `${msg.dedupeKey}:${target.value}` : null;
    if (dedupeKey && emailSeenRecently(dedupeKey)) {
      return { ok: true, skipped: true };
    }
    const sent = await emailService.send({
      to: target.value,
      subject: subjectLine(msg),
      text: plainTextBody(msg),
    });
    // Record only on success so a failed send is retried by the next webhook.
    if (sent && dedupeKey) recentEmails.set(dedupeKey, Date.now() + EMAIL_DEDUPE_TTL_MS);
    return sent ? { ok: true } : { ok: false, error: 'email-send-failed' };
  },
};

// -- Factory ------------------------------------------------------------------

const CHANNELS: Record<string, NotificationChannel> = {
  'slack': slackChannel,
  'webhook': webhookChannel,
  'in-app': inAppChannel,
  'email': emailChannel,
};

/** Resolve the channel adapter for a destination's `channel`, or null if the
 *  value isn't a known channel (it's DB data, so an unknown value is possible
 *  — the caller logs + counts it rather than throwing). */
export function getNotificationChannel(channel: string): NotificationChannel | null {
  return CHANNELS[channel] ?? null;
}
