// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * N22 — moderation SLA breach (docs/plans/plugin-ecosystem.md §5b, §9a): when
 * an open request passes its lane's SLA (standard 48 h, security-fix 4 h), the
 * Ecosystem Managers are emailed at once (transactional, no opt-out). The
 * Prometheus alerts on `ecosystem_requests_sla_breached` are the paging half.
 *
 * Run from the leader-locked maintenance scheduler. DEDUPLICATED: each request
 * is announced once — the ids already announced live in one
 * `ecosystem_settings` row, pruned as requests leave the queue — so a breach
 * doesn't repeat every tick, and a failed send is retried on the next tick
 * (the id is recorded only after the notice was accepted).
 */

import { emitCounter, createLogger, errorMessage, SYSTEM_ACTOR_ID } from '@pipeline-builder/api-core';
import type { PluginPublishRequest, Publisher } from '@pipeline-builder/pipeline-data';

import { slaBreached, slaHoursFor } from './metrics.js';
import { moderators, requestTitle } from './notify.js';
import { requiredDecisionPermission } from './policy.js';
import { listings, OPEN_STATUSES, publishers, requests, settings } from './store.js';
import { enqueueEcosystemNotification } from '../ecosystem-notifications.js';

const logger = createLogger('ecosystem-sla');

/** The `ecosystem_settings` row holding `{ [requestId]: announcedAtIso }`. */
export const SLA_NOTIFIED_KEY = 'sla-breach-notified';
/** At most this many requests listed in one notice (the rest are counted). */
const MAX_LISTED = 25;

type DecisionPermission = 'plugins:moderate' | 'publishers:verify';

function hoursOld(r: PluginPublishRequest, now: Date): number {
  return Math.floor((now.getTime() - new Date(r.createdAt).getTime()) / 3_600_000);
}

async function titleOf(r: PluginPublishRequest, cache: Map<string, Publisher | null>): Promise<string> {
  if (!cache.has(r.publisherId)) cache.set(r.publisherId, await publishers.byId(r.publisherId));
  const handle = cache.get(r.publisherId)?.handle ?? 'unknown';
  const name = r.listingId ? (await listings.byId(r.listingId))?.name ?? null : (typeof r.payload?.name === 'string' ? r.payload.name.replace(/^(handle|listing):/, '') : null);
  return requestTitle({ kind: r.kind, handle, name, version: r.version });
}

/**
 * Announce every newly breached open request (N22), grouped by the permission
 * that decides it, security-fix lane first. Returns how many were announced.
 */
export async function notifySlaBreaches(now: Date = new Date()): Promise<number> {
  const open = await requests.list({ statuses: OPEN_STATUSES, limit: 5_000 });
  const openIds = new Set(open.map((r) => r.id));
  const announced = (await settings.get<Record<string, string>>(SLA_NOTIFIED_KEY)) ?? {};
  // Forget requests that left the queue (decided, withdrawn): the row stays small.
  const kept: Record<string, string> = Object.fromEntries(Object.entries(announced).filter(([id]) => openIds.has(id)));
  let dirty = Object.keys(kept).length !== Object.keys(announced).length;

  const fresh = open.filter((r) => slaBreached(r, now) && !kept[r.id])
    .sort((a, b) => (a.lane === b.lane ? new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime() : a.lane === 'security' ? -1 : 1));
  const groups = new Map<DecisionPermission, PluginPublishRequest[]>();
  for (const r of fresh) {
    const permission = requiredDecisionPermission(r.kind) as DecisionPermission;
    groups.set(permission, [...(groups.get(permission) ?? []), r]);
  }

  const pubs = new Map<string, Publisher | null>();
  let count = 0;
  for (const [permission, rows] of groups) {
    const security = rows.filter((r) => r.lane === 'security').length;
    const lines: string[] = [];
    for (const r of rows.slice(0, MAX_LISTED)) {
      lines.push(`- ${await titleOf(r, pubs)} — ${r.lane === 'security' ? 'security-fix lane' : 'standard lane'}, ${hoursOld(r, now)}h old (SLA ${slaHoursFor(r.lane)}h)${r.status === 'pending_second_approval' ? ', awaiting a second approval' : ''}`);
    }
    if (rows.length > MAX_LISTED) lines.push(`- …and ${rows.length - MAX_LISTED} more`);
    const subject = `Moderation SLA breached: ${rows.length} request${rows.length === 1 ? '' : 's'}${security ? ` (${security} security-fix)` : ''}`;
    const text = `These requests are past their moderation SLA and need a decision in the Ecosystem console:\n\n${lines.join('\n')}`;
    try {
      await enqueueEcosystemNotification('N22', [moderators(permission)], { subject, text }, { immediate: true, mandatory: true });
    } catch (err) {
      emitCounter('ecosystem_notification_failed_total', { event: 'N22' });
      logger.warn('SLA-breach notice not sent; retried next pass', { permission, error: errorMessage(err) });
      continue;
    }
    for (const r of rows) {
      kept[r.id] = now.toISOString();
      emitCounter('ecosystem_sla_breach_notices_total', { lane: r.lane });
    }
    dirty = true;
    count += rows.length;
  }
  if (dirty) await settings.put(SLA_NOTIFIED_KEY, kept, SYSTEM_ACTOR_ID);
  return count;
}
