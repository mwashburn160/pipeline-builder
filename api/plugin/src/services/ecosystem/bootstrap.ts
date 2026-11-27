// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The one-time BOOTSTRAP exception: the initial Official catalog is approved
 * automatically while the window is open, then the exception closes for good
 * (docs/runbooks/ecosystem-moderation.md).
 */

import { createLogger, SYSTEM_ACTOR_ID } from '@pipeline-builder/api-core';
import { OFFICIAL_PUBLISHER_HANDLE, type PluginPublishRequest, type Publisher } from '@pipeline-builder/pipeline-data';
import { sql } from 'drizzle-orm';

import { ecosystemAudit } from './audit.js';
import { isOfficialLoader, type Caller } from './context.js';
import { atomically, elevated, listings, settings } from './store.js';
import { config } from '../../config.js';

const logger = createLogger('ecosystem-bootstrap');

type Req = PluginPublishRequest;

// -----------------------------------------------------------------------------
// Bootstrap exception
// -----------------------------------------------------------------------------

export const BOOTSTRAP_KEY = 'bootstrap';

export interface BootstrapState {
  openedAt: string | null;
  closedAt: string | null;
  reason: string | null;
  approved: number;
}

/** How long the bootstrap window stays open once the first Official request rides it. */
export function bootstrapWindowMs(): number {
  return config.ecosystem.bootstrapWindowMs;
}

/** The advisory lock every first opener takes (the settings row may not exist yet). */
const BOOTSTRAP_LOCK = 'ecosystem-bootstrap';

/** Whether an opened window has run past {@link bootstrapWindowMs}. */
function windowElapsed(state: BootstrapState): boolean {
  return state.openedAt !== null && Date.now() - new Date(state.openedAt).getTime() > bootstrapWindowMs();
}

/** The bootstrap exception before it was ever opened. */
const NO_BOOTSTRAP: BootstrapState = { openedAt: null, closedAt: null, reason: null, approved: 0 };

export async function bootstrapState(): Promise<BootstrapState> {
  return (await settings.get<BootstrapState>(BOOTSTRAP_KEY)) ?? NO_BOOTSTRAP;
}

/** Close the bootstrap exception for good (idempotent). */
export async function closeBootstrap(reason: string, by: string): Promise<void> {
  if ((await bootstrapState()).closedAt) return;
  const closed = await atomically(async () => {
    const state = (await settings.getForUpdate<BootstrapState>(BOOTSTRAP_KEY)) ?? NO_BOOTSTRAP;
    if (state.closedAt) return false;
    await settings.put(BOOTSTRAP_KEY, { ...state, closedAt: new Date().toISOString(), reason }, by);
    return { openedAt: state.openedAt, approved: state.approved };
  });
  if (closed) {
    logger.info('Ecosystem bootstrap exception closed', { reason });
    // The window auto-approved Official versions with no human decision; when
    // it shut, why, and how much rode it belong on the durable trail.
    ecosystemAudit({ action: 'ecosystem.bootstrap.close', actor: by, targetType: 'ecosystem-bootstrap', targetId: BOOTSTRAP_KEY, details: { reason, openedAt: closed.openedAt, approved: closed.approved } });
  }
}

/**
 * Whether `r` rides the bootstrap exception: an Official request from the
 * catalog loader while the instance has no listings of its own making. The
 * window OPENS on the first such request of an empty instance and stays open
 * for the initial load (`ECOSYSTEM_BOOTSTRAP_WINDOW_HOURS`, default 24) —
 * builds finish in parallel, so "zero listings" is judged when the load
 * starts, not per plugin. It closes for good when the window elapses, when any
 * manager decides a request, or when the instance already had listings.
 */
export async function bootstrapEligible(r: Req, publisher: Publisher, submitter: Caller): Promise<boolean> {
  if (publisher.handle !== OFFICIAL_PUBLISHER_HANDLE || !isOfficialLoader(submitter)) return false;
  if (!['new_listing', 'new_version', 'listing_update'].includes(r.kind)) return false;
  const state = await bootstrapState();
  if (state.closedAt) return false;
  if (!state.openedAt) {
    // Judged ONLY under the lock. The read above is unlocked: a concurrent
    // opener may have opened the window (and its publish listed a plugin) since,
    // and closing on that listing as `listings_exist` shut the exception for
    // every catalog plugin still building. And the settings row does not exist
    // before the first open, so `FOR UPDATE` alone locks nothing: two first
    // openers both inserted it and the loser's request threw after it was
    // stored, left pending. The advisory lock serializes them.
    const opened = await atomically(async () => {
      await elevated((tx) => tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${BOOTSTRAP_LOCK}))`));
      const cur = (await settings.getForUpdate<BootstrapState>(BOOTSTRAP_KEY)) ?? NO_BOOTSTRAP;
      if (cur.closedAt) return { eligible: false, openedNow: false, listingsExist: false };
      if (cur.openedAt) return { eligible: !windowElapsed(cur), openedNow: false, listingsExist: false };
      if ((await listings.countAll()) > 0) return { eligible: false, openedNow: false, listingsExist: true };
      await settings.put(BOOTSTRAP_KEY, { ...cur, openedAt: new Date().toISOString() }, SYSTEM_ACTOR_ID);
      return { eligible: true, openedNow: true, listingsExist: false };
    });
    if (opened.listingsExist) {
      await closeBootstrap('listings_exist', SYSTEM_ACTOR_ID);
      return false;
    }
    // Opening the window switches on automatic approval of Official requests
    // for ECOSYSTEM_BOOTSTRAP_WINDOW_HOURS — audited once, by the opener only.
    if (opened.openedNow) {
      ecosystemAudit({ action: 'ecosystem.bootstrap.open', actor: SYSTEM_ACTOR_ID, targetType: 'ecosystem-bootstrap', targetId: BOOTSTRAP_KEY, details: { requestId: r.id, kind: r.kind, windowHours: bootstrapWindowMs() / 3_600_000, submitter: submitter.userId } });
    }
    return opened.eligible;
  }
  if (windowElapsed(state)) {
    await closeBootstrap('window_elapsed', SYSTEM_ACTOR_ID);
    return false;
  }
  return true;
}

/** Count one bootstrap approval — a locked read-modify-write, so concurrent approvals never lose a count. */
export async function countBootstrapApproval(): Promise<void> {
  await atomically(async () => {
    const state = (await settings.getForUpdate<BootstrapState>(BOOTSTRAP_KEY)) ?? NO_BOOTSTRAP;
    await settings.put(BOOTSTRAP_KEY, { ...state, approved: state.approved + 1 }, SYSTEM_ACTOR_ID);
  });
}
