// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared notification-channel contract + the transports that are genuinely the
 * same everywhere.
 *
 * Two services had grown their own copy of this (platform's alert relay and
 * compliance's notifier) with INCOMPATIBLE contracts — `target.value` vs
 * `target.url`, a severity enum vs a priority enum, `skipped` present in one
 * result shape and absent in the other, and two separate SSRF postures in the
 * two webhook senders. This module is the single contract; the webhook and
 * email transports live here.
 *
 * What stays per-service: the `in-app` transport only. Compliance posts to the
 * message service over HTTP; platform (which is the alert ingress and must not
 * add a network hop to an alert fan-out) writes the shared `messages` table
 * directly under a superadmin tenant context. Those are genuinely different
 * transports, not duplication.
 */

import { createHmac } from 'crypto';

import { errorMessage } from '../utils/response.js';
import { safeFetch } from '../utils/ssrf.js';

/** Inbox priority every channel renders from. */
export type NotificationPriority = 'urgent' | 'high' | 'normal';

/**
 * Transport-agnostic notification payload. Channels render from these fields;
 * `payload` is the exact JSON the generic `webhook` channel forwards unchanged
 * (so an existing webhook consumer keeps receiving the shape it expects).
 */
export interface NotificationMessage {
  /** Org whose inbox / destination receives this. */
  recipientOrgId: string;
  /** Short subject line, already prefixed/decorated by the caller. */
  subject: string;
  /** Plain-text body. */
  body: string;
  priority: NotificationPriority;
  messageType: 'announcement' | 'conversation';
  /** Structured body forwarded verbatim by the webhook channel. */
  payload: unknown;
  /** Stable key for at-least-once channels (email) to dedupe retries. */
  dedupeKey?: string;
}

/**
 * Channel-specific delivery target. `value` is the URL (webhook/slack) or the
 * email address; `secret` is the webhook HMAC key; `targetUsers` narrows an
 * email fan-out (null/absent = every org admin).
 */
export interface ChannelTarget {
  value?: string;
  secret?: string;
  targetUsers?: string[] | null;
  orgId?: string;
}

/**
 * Outcome of one delivery. `skipped` distinguishes "intentionally not sent"
 * (email disabled, dedupe hit) from a real failure so the caller can count them
 * apart; `code`/`error` feed structured logging and the audit trail.
 */
export interface DeliveryResult {
  ok: boolean;
  skipped?: boolean;
  code?: number;
  error?: string;
}

/**
 * One delivery transport. Generic in the message type so a service can carry
 * extra rendering fields (platform's alert severity/labels) without loosening
 * the shared contract or casting.
 */
export interface NotificationChannel<M extends NotificationMessage = NotificationMessage> {
  readonly channel: string;
  deliver(msg: M, target: ChannelTarget, signal?: AbortSignal): Promise<DeliveryResult>;
}

/** Options for {@link createWebhookChannel}. */
export interface WebhookChannelOptions<M extends NotificationMessage = NotificationMessage> {
  /** Channel name (default `'webhook'`). */
  name?: string;
  /** Allowed URL protocols (default https-only). */
  protocols?: string[];
  /** Per-delivery wall-clock cap in ms. */
  timeoutMs?: number;
  /** Render the JSON body; defaults to `msg.payload` forwarded verbatim. */
  render?: (msg: M) => unknown;
}

/**
 * Generic outbound webhook transport.
 *
 * The URL is org-controlled, so delivery goes through {@link safeFetch}: the
 * host is resolved and vetted, the vetted IP is PINNED into the socket (no
 * DNS-rebinding window between the check and the connect), and redirects are
 * refused — a 3xx is a FAILED delivery, never a pivot to an unvetted host and
 * never recorded green. Signed with `X-PB-Signature` when the target carries a
 * secret; targets without one (alert destinations) stay unsigned.
 */
export function createWebhookChannel<M extends NotificationMessage = NotificationMessage>(
  opts: WebhookChannelOptions<M> = {},
): NotificationChannel<M> {
  const render = opts.render ?? ((msg: M) => msg.payload);
  return {
    channel: opts.name ?? 'webhook',
    async deliver(msg, target, signal) {
      if (!target.value) return { ok: false, error: 'no webhook url' };
      const body = JSON.stringify(render(msg));
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (target.secret) {
        headers['X-PB-Signature'] = `sha256=${createHmac('sha256', target.secret).update(body).digest('hex')}`;
      }
      try {
        const resp = await safeFetch(target.value, {
          method: 'POST',
          headers,
          body,
          signal,
          protocols: opts.protocols,
          timeoutMs: opts.timeoutMs,
        });
        if (resp.redirected) {
          return { ok: false, code: resp.status, error: 'webhook url redirected (refused)' };
        }
        return resp.ok ? { ok: true, code: resp.status } : { ok: false, code: resp.status };
      } catch (err) {
        return { ok: false, error: errorMessage(err) };
      }
    },
  };
}

/** Arguments handed to an {@link EmailChannelOptions.send} implementation. */
export interface EmailSendRequest {
  /** The target address, when the transport addresses one recipient directly. */
  to?: string;
  /** Org whose admins/users receive it, when the transport resolves recipients. */
  orgId: string;
  /** Narrowed recipient list, or null for "every org admin". */
  targetUsers?: string[] | null;
  subject: string;
  text: string;
}

/** Options for {@link createEmailChannel}. */
export interface EmailChannelOptions {
  /** Perform the send; resolve false for a transport-level failure. */
  send: (req: EmailSendRequest) => Promise<boolean>;
  /** Report whether email is configured at all on this deploy (default: yes). */
  enabled?: () => boolean;
  /**
   * At-least-once dedupe window. A repeat of the same `(dedupeKey, target)`
   * inside the window is reported `{ ok: true, skipped: true }` rather than
   * re-sent. Omit/0 to disable.
   */
  dedupeTtlMs?: number;
}

/**
 * Email transport. The actual delivery mechanism is injected (`send`) because
 * it legitimately differs — platform has SMTP/SES, compliance asks platform to
 * send on its behalf — but the parts that were duplicated-and-drifting are
 * here: the enabled/skipped semantics and the at-least-once dedupe window (a
 * webhook-retrying alert source would otherwise re-mail the same event).
 */
export function createEmailChannel<M extends NotificationMessage = NotificationMessage>(
  opts: EmailChannelOptions,
): NotificationChannel<M> {
  const ttl = opts.dedupeTtlMs ?? 0;
  const recent = new Map<string, number>(); // dedupe key -> expiry (epoch ms)

  const seenRecently = (key: string): boolean => {
    const now = Date.now();
    for (const [k, exp] of recent) {
      if (exp <= now) recent.delete(k);
    }
    return recent.has(key);
  };

  return {
    channel: 'email',
    async deliver(msg, target) {
      // Email unconfigured on this deploy → report SKIPPED (not delivered) so a
      // caller never claims it sent something it didn't.
      if (opts.enabled && !opts.enabled()) {
        return { ok: false, skipped: true, error: 'email-disabled' };
      }
      const dedupeKey = ttl > 0 && msg.dedupeKey ? `${msg.dedupeKey}:${target.value ?? msg.recipientOrgId}` : null;
      if (dedupeKey && seenRecently(dedupeKey)) {
        return { ok: true, skipped: true };
      }
      try {
        const sent = await opts.send({
          to: target.value,
          orgId: msg.recipientOrgId,
          targetUsers: target.targetUsers ?? null,
          subject: msg.subject,
          text: msg.body,
        });
        // Record only on success, so a failed send is retried by the next event.
        if (sent && dedupeKey) recent.set(dedupeKey, Date.now() + ttl);
        return sent ? { ok: true } : { ok: false, error: 'email-send-failed' };
      } catch (err) {
        return { ok: false, error: errorMessage(err) };
      }
    },
  };
}

/**
 * Build the per-service channel registry. Returns a resolver that yields `null`
 * for an unknown name — the channel is DB data, so an unknown value is possible
 * and the caller logs/counts it rather than throwing.
 */
export function createChannelRegistry<M extends NotificationMessage = NotificationMessage>(
  channels: NotificationChannel<M>[],
): (channel: string) => NotificationChannel<M> | null {
  const byName = new Map(channels.map((c) => [c.channel, c]));
  return (channel: string) => byName.get(channel) ?? null;
}
