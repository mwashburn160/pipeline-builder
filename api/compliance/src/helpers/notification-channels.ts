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
import { lookup } from 'dns/promises';
import { request as httpsRequest, type RequestOptions } from 'https';
import { isIP } from 'net';

import { errorMessage, getServiceAuthHeader, SYSTEM_ORG_ID } from '@pipeline-builder/api-core';

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

/** True for loopback / private / link-local / CGNAT / cloud-metadata addresses. */
function isPrivateAddress(ip: string): boolean {
  const addr = ip.replace(/^\[|\]$/g, '').toLowerCase();
  const v4 = addr.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const a = Number(v4[1]), b = Number(v4[2]);
    return a === 0 || a === 10 || a === 127
      || (a === 169 && b === 254) // link-local incl. 169.254.169.254 metadata
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || (a === 100 && b >= 64 && b <= 127); // CGNAT
  }
  if (addr === '::1' || addr === '::') return true;
  if (addr.startsWith('::ffff:')) return isPrivateAddress(addr.slice(7)); // v4-mapped v6
  return addr.startsWith('fc') || addr.startsWith('fd') // unique-local
    || addr.startsWith('fe80'); // link-local
}

/** A DNS-resolved, SSRF-vetted webhook target to connect to by pinned IP. */
interface PinnedTarget {
  /** Original hostname — preserved for the Host header and TLS SNI. */
  host: string;
  /** The exact validated IP the socket must connect to (no re-resolution). */
  address: string;
  family: number;
  port: number;
}

/**
 * SSRF guard for org-supplied webhook URLs: require https and reject any host
 * that is — or resolves to — a private/loopback/link-local/metadata address, so
 * a tenant can't aim a webhook at the cloud metadata endpoint or internal
 * services. Returns the vetted IP so the delivery can PIN it into the socket:
 * validating the host here and then letting `fetch`/DNS re-resolve at send time
 * is a TOCTOU DNS-rebinding hole (the second lookup can return a private IP).
 * Pinning closes it — the connection only ever reaches the address we vetted.
 */
async function resolveSafeWebhookTarget(rawUrl: string): Promise<PinnedTarget> {
  let u: URL;
  try { u = new URL(rawUrl); } catch { throw new Error('invalid webhook url'); }
  if (u.protocol !== 'https:') throw new Error('webhook url must use https');
  const host = u.hostname;
  const port = u.port ? Number(u.port) : 443;
  const literalFamily = isIP(host);
  if (literalFamily) {
    if (isPrivateAddress(host)) throw new Error('webhook url targets a private address');
    return { host, address: host, family: literalFamily, port };
  }
  let addrs: { address: string; family: number }[];
  try { addrs = await lookup(host, { all: true }); } catch { throw new Error('webhook host did not resolve'); }
  if (addrs.length === 0) throw new Error('webhook host did not resolve');
  // Reject if ANY resolution is private (defense in depth), then PIN the first
  // vetted address — the send connects to exactly this IP, so a rebind that
  // re-resolves the host to a private address afterwards can never take effect.
  if (addrs.some((a) => isPrivateAddress(a.address))) throw new Error('webhook url resolves to a private address');
  return { host, address: addrs[0].address, family: addrs[0].family, port };
}

/**
 * POST `body` over https, connecting ONLY to the already-validated `pin.address`.
 * The pinned `lookup` short-circuits DNS so `net.connect` never re-resolves the
 * host — this is what defeats DNS rebinding. SNI + Host stay the original
 * hostname so TLS certificate verification is unchanged. Redirects are never
 * auto-followed (https.request doesn't), so a 3xx surfaces as its status for the
 * caller to treat as a failed delivery rather than pivoting to an unvetted host.
 */
function postPinnedHttps(
  pin: PinnedTarget,
  rawUrl: string,
  headers: Record<string, string>,
  body: string,
  signal?: AbortSignal,
): Promise<{ status: number }> {
  const u = new URL(rawUrl);
  const options: RequestOptions = {
    method: 'POST',
    hostname: pin.host,
    port: pin.port,
    path: `${u.pathname}${u.search}`,
    servername: pin.host, // preserve SNI so the cert is validated against the hostname
    headers: { ...headers, 'Content-Length': String(Buffer.byteLength(body)) },
    signal,
    // Pin the vetted IP: net.connect uses this instead of re-resolving the host.
    lookup: ((_hostname: string, _opts: unknown, cb: (err: Error | null, address: string, family: number) => void) => {
      cb(null, pin.address, pin.family);
    }) as unknown as RequestOptions['lookup'],
  };
  return new Promise((resolve, reject) => {
    const clientReq = httpsRequest(options, (res) => {
      res.resume(); // drain the body so the socket can be released
      res.on('end', () => resolve({ status: res.statusCode ?? 0 }));
      res.on('error', reject);
    });
    clientReq.on('error', reject);
    clientReq.end(body);
  });
}

const webhookChannel: NotificationChannel = {
  channel: 'webhook',
  async deliver(n, target, signal) {
    if (!target.url) return { ok: false, error: 'no webhook url' };
    let pin: PinnedTarget;
    try {
      pin = await resolveSafeWebhookTarget(target.url);
    } catch (err) {
      return { ok: false, error: errorMessage(err) };
    }
    const body = JSON.stringify(n.payload);
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    // Sign when a secret is configured so the receiver can verify authenticity.
    if (target.secret) {
      headers['X-PB-Signature'] = `sha256=${createHmac('sha256', target.secret).update(body).digest('hex')}`;
    }
    try {
      const { status } = await postPinnedHttps(pin, target.url, headers, body, signal);
      // A redirect is a failed delivery, not a success: the pinned connection
      // won't follow it to an unvalidated host, and recording it green would be
      // a false positive.
      if (status >= 300 && status < 400) {
        return { ok: false, code: status, error: 'webhook url redirected (refused)' };
      }
      return status >= 200 && status < 300 ? { ok: true, code: status } : { ok: false, code: status };
    } catch (err) {
      return { ok: false, error: errorMessage(err) };
    }
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
          Authorization: getServiceAuthHeader({ serviceName: 'compliance', orgId: SYSTEM_ORG_ID, role: 'member' }),
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
