// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Plugin-ecosystem notifications: the enqueue API later waves call, and the
 * leader-locked dispatcher that flushes `ecosystem_notification_queue`
 * (docs/plans/plugin-ecosystem.md §5b).
 *
 * Delivery goes through platform's notify relay (`createEcosystemNotifyClient`),
 * which resolves the recipient RULES at send time, applies each user's
 * `ecosystem.*` email preferences and sends the in-app copy + one email per
 * recipient. This module never sees an address or a member list.
 *
 * Timing:
 *  - **immediate** events are sent at once; if platform is unreachable the
 *    notice is written to the queue (due now) and the dispatcher retries it, so
 *    a transient outage never loses a notice;
 *  - **batched** events (the §5b digest events, or any call with a `digestKey`
 *    or a delay) send the in-app copy at once — in-app is the source of truth —
 *    and queue the EMAIL. Every queued row sharing a `digest_key` that is due is
 *    coalesced into ONE email at `deliver_after` (09:00 UTC daily, Monday 09:00
 *    weekly, top of the hour hourly — api-core `nextEcosystemDigestTime`).
 */

import {
  createEcosystemNotifyClient,
  createLogger,
  createScheduler,
  ECOSYSTEM_NOTIFICATION_EVENTS,
  errorMessage,
  nextEcosystemDigestTime,
  parseEcosystemNotifyRequest,
  renderEcosystemDigest,
  type EcosystemNotificationChannel,
  type EcosystemNotificationEventId,
  type EcosystemNotifyClient,
  type EcosystemNotifyRequest,
  type EcosystemRecipientSpec,
  type LockRedis,
  type Scheduler,
} from '@pipeline-builder/api-core';
import { incCounter } from '@pipeline-builder/api-server';
import { runWithTenantContext, schema, withTenantTx } from '@pipeline-builder/pipeline-data';
import { and, asc, inArray, isNull, lte } from 'drizzle-orm';

const logger = createLogger('ecosystem-notifications');

/** How often the dispatcher looks for due rows. */
export const DISPATCH_INTERVAL_MS = 60_000;
/** Rows claimed per tick (a digest larger than this flushes over two ticks). */
export const DISPATCH_BATCH = 200;
/** Send attempts before a row is given up on (dropped, counted, logged). */
export const MAX_ATTEMPTS = 8;
const LOCK_KEY = 'ecosystem-notifications:leader';
const LOCK_TTL_MS = 5 * 60_000;

/** What a queued row's `payload` holds. */
interface QueuedPayload {
  recipients: EcosystemRecipientSpec[];
  subject: string;
  text: string;
  channels: EcosystemNotificationChannel[];
  mandatory?: boolean;
  attempts?: number;
}

/** A notice's content. */
export interface EcosystemNoticeContent { subject: string; text: string }

export interface EnqueueOptions {
  /** Coalesce with other queued rows sharing this key into one email. Defaults
   *  to `<event>:<recipients>` for a §5b digest event. Namespace it by event. */
  digestKey?: string;
  /** Delay the email by this much instead of the event's digest slot. */
  delayMs?: number;
  /** Exact delivery time (wins over `delayMs` and the digest slot). */
  deliverAfter?: Date;
  /** Send now even for a digest event (N13 `breaking` major; N24 yank,
   *  advisory and security-fix requests). */
  immediate?: boolean;
  /** Email even users who opted out (N24 yank / advisory / security-fix). */
  mandatory?: boolean;
}

/** How an enqueue was handled. */
export type EnqueueOutcome = 'sent' | 'queued' | 'retry_queued';

let client: EcosystemNotifyClient | undefined;
function notifyClient(): EcosystemNotifyClient {
  client ??= createEcosystemNotifyClient({ serviceName: 'plugin' });
  return client;
}

/** Test hook: swap the relay client. */
export function setEcosystemNotifyClientForTests(c: EcosystemNotifyClient | undefined): void {
  client = c;
}

/** A stable key for a recipient-rule set (the default digest key). */
function recipientsKey(recipients: readonly EcosystemRecipientSpec[]): string {
  return recipients.map((r) => JSON.stringify(r, Object.keys(r).sort())).sort().join('|');
}

/** The first org a rule set names (bookkeeping column only). */
function firstOrg(recipients: readonly EcosystemRecipientSpec[]): string | null {
  for (const r of recipients) if ('orgId' in r && r.orgId) return r.orgId;
  return null;
}

async function insertRow(
  event: EcosystemNotificationEventId,
  payload: QueuedPayload,
  deliverAfter: Date,
  digestKey: string | null,
): Promise<void> {
  const user = payload.recipients.find((r): r is Extract<EcosystemRecipientSpec, { kind: 'user' }> => r.kind === 'user');
  await runWithTenantContext({ isSuperAdmin: true }, () => withTenantTx((tx) => tx.insert(schema.ecosystemNotificationQueue).values({
    event,
    digestKey,
    recipientOrgId: firstOrg(payload.recipients),
    recipientUserId: user?.userId ?? null,
    payload: payload as unknown as Record<string, unknown>,
    deliverAfter,
  })));
}

/**
 * A subject safe to put in a mail header: every control character (CR/LF
 * included — a plugin name or a reason is user text) collapsed to one space.
 * The body is plain text and keeps its line breaks.
 */
export function headerSafeSubject(subject: string): string {
  // eslint-disable-next-line no-control-regex
  return subject.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
}

/**
 * Send (or queue) one ecosystem notice to recipient RULES. Throws only for an
 * invalid notice (a programming error, never retried) or when the queue write
 * itself fails.
 *
 * ```ts
 * await enqueueEcosystemNotification('N24', [{ kind: 'moderators', permission: 'plugins:moderate', excludeMembersOfOrgId: publisherOrgId }],
 *   { subject: 'New listing: acme/lint 1.0.0', text: '…' });
 * ```
 */
export async function enqueueEcosystemNotification(
  event: EcosystemNotificationEventId,
  recipients: EcosystemRecipientSpec[],
  content: EcosystemNoticeContent,
  opts: EnqueueOptions = {},
): Promise<EnqueueOutcome> {
  const spec = ECOSYSTEM_NOTIFICATION_EVENTS[event];
  const request: EcosystemNotifyRequest = {
    event, recipients, subject: headerSafeSubject(content.subject), text: content.text, ...(opts.mandatory ? { mandatory: true } : {}),
  };
  const parsed = parseEcosystemNotifyRequest(request);
  if (typeof parsed === 'string') throw new Error(`Invalid ecosystem notification: ${parsed}`);

  const batched = !opts.immediate && (opts.digestKey !== undefined || opts.delayMs !== undefined || opts.deliverAfter !== undefined || spec.digest !== undefined);
  const channels = [...spec.channels];

  if (!batched) {
    const result = await notifyClient().send(parsed);
    if (result.ok) {
      incCounter('ecosystem_notifications_total', { event, outcome: 'sent' });
      return 'sent';
    }
    // Durable retry: the dispatcher picks it up on its next tick.
    await insertRow(event, { ...stripRequest(parsed), channels, attempts: 1 }, new Date(Date.now() + backoffMs(1)), null);
    incCounter('ecosystem_notifications_total', { event, outcome: 'retry_queued' });
    return 'retry_queued';
  }

  // In-app now (the source of truth); the EMAIL waits for the digest.
  let emailChannels: EcosystemNotificationChannel[] = channels.filter((c) => c === 'email');
  if (channels.includes('in_app')) {
    const inApp = await notifyClient().send({ ...parsed, channels: ['in_app'] });
    if (!inApp.ok) emailChannels = channels; // queue the in-app copy too
  }
  if (emailChannels.length === 0) {
    incCounter('ecosystem_notifications_total', { event, outcome: 'sent' });
    return 'sent';
  }
  const deliverAfter = opts.deliverAfter
    ?? (opts.delayMs !== undefined ? new Date(Date.now() + opts.delayMs) : nextEcosystemDigestTime(spec.digest ?? 'hourly'));
  const digestKey = opts.digestKey ?? `${event}:${recipientsKey(parsed.recipients)}`;
  await insertRow(event, { ...stripRequest(parsed), channels: emailChannels }, deliverAfter, digestKey);
  incCounter('ecosystem_notifications_total', { event, outcome: 'queued' });
  return 'queued';
}

function stripRequest(r: EcosystemNotifyRequest): Omit<QueuedPayload, 'channels'> {
  return { recipients: r.recipients, subject: r.subject, text: r.text, ...(r.mandatory ? { mandatory: true } : {}) };
}

/** Retry backoff: 1, 2, 4 … minutes, capped at an hour. */
export function backoffMs(attempts: number): number {
  return Math.min(60 * 60_000, 60_000 * 2 ** Math.max(0, attempts - 1));
}

type QueueRow = typeof schema.ecosystemNotificationQueue.$inferSelect;

/** The result of one dispatcher tick. */
export interface DispatchResult { groups: number; delivered: number; retried: number; dropped: number }

/**
 * One dispatcher tick: claim due, undelivered rows; coalesce rows sharing a
 * `digest_key` (and event) into one notice; send; mark delivered, or back off
 * and retry, dropping after {@link MAX_ATTEMPTS}. Exported for tests.
 */
export async function dispatchDueEcosystemNotifications(now: Date = new Date()): Promise<DispatchResult> {
  const q = schema.ecosystemNotificationQueue;
  const result: DispatchResult = { groups: 0, delivered: 0, retried: 0, dropped: 0 };

  await runWithTenantContext({ isSuperAdmin: true }, async () => {
    const due: QueueRow[] = await withTenantTx((tx) => tx.select().from(q)
      .where(and(isNull(q.deliveredAt), lte(q.deliverAfter, now)))
      .orderBy(asc(q.deliverAfter))
      .limit(DISPATCH_BATCH));

    const groups = new Map<string, QueueRow[]>();
    for (const row of due) {
      const key = row.digestKey ? `${row.event}\u0000${row.digestKey}` : `row\u0000${row.id}`;
      const group = groups.get(key) ?? [];
      group.push(row);
      groups.set(key, group);
    }

    for (const rows of groups.values()) {
      result.groups++;
      const ids = rows.map((r) => r.id);
      const event = rows[0]!.event as EcosystemNotificationEventId;
      const payloads = rows.map((r) => r.payload as unknown as QueuedPayload);
      const recipients = new Map<string, EcosystemRecipientSpec>();
      for (const p of payloads) for (const r of p.recipients ?? []) recipients.set(recipientsKey([r]), r);
      const channels = [...new Set(payloads.flatMap((p) => p.channels ?? []))];
      const content = renderEcosystemDigest(event, payloads.map((p) => ({ subject: p.subject, text: p.text })));
      const attempts = Math.max(...payloads.map((p) => p.attempts ?? 0)) + 1;

      let ok = false;
      try {
        ok = (await notifyClient().send({
          event,
          recipients: [...recipients.values()],
          ...content,
          ...(channels.length > 0 ? { channels } : {}),
          ...(payloads.some((p) => p.mandatory) ? { mandatory: true } : {}),
        })).ok;
      } catch (err) {
        // An unsendable row (corrupt payload) can never succeed: drop it now.
        logger.error('Dropping an invalid queued ecosystem notification', { event, ids, error: errorMessage(err) });
        await markDelivered(ids, now);
        result.dropped += rows.length;
        incCounter('ecosystem_notification_dropped_total', { event });
        continue;
      }

      if (ok) {
        await markDelivered(ids, now);
        result.delivered += rows.length;
        incCounter('ecosystem_notifications_dispatched_total', { event });
      } else if (attempts >= MAX_ATTEMPTS) {
        logger.error('Giving up on an ecosystem notification after repeated failures', { event, ids, attempts });
        await markDelivered(ids, now);
        result.dropped += rows.length;
        incCounter('ecosystem_notification_dropped_total', { event });
      } else {
        const next = new Date(now.getTime() + backoffMs(attempts));
        await withTenantTx((tx) => Promise.all(rows.map((r) => tx.update(q)
          .set({ deliverAfter: next, payload: { ...(r.payload as Record<string, unknown>), attempts } })
          .where(inArray(q.id, [r.id])))));
        result.retried += rows.length;
      }
    }
  });

  if (result.groups > 0) logger.info('Ecosystem notification dispatch', { ...result });
  return result;
}

async function markDelivered(ids: string[], at: Date): Promise<void> {
  const q = schema.ecosystemNotificationQueue;
  await withTenantTx((tx) => tx.update(q).set({ deliveredAt: at }).where(inArray(q.id, ids)));
}

/**
 * Build (not start) the dispatcher: one tick a minute, leader-locked so only one
 * replica flushes a digest (the soft-delete-sweep / vuln-rescan pattern). The
 * lock rides the plugin service's shared Redis connection.
 */
export function createEcosystemNotificationScheduler(redis: () => LockRedis): Scheduler {
  return createScheduler({
    name: 'ecosystem-notifications',
    intervalMs: DISPATCH_INTERVAL_MS,
    startupDelayMs: 30_000,
    lock: { redis, key: LOCK_KEY, ttlMs: LOCK_TTL_MS },
    run: async () => { await dispatchDueEcosystemNotifications(); },
  });
}
