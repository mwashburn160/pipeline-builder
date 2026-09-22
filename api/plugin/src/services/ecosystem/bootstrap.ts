// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The one-time BOOTSTRAP exception: the initial Official catalog is approved
 * automatically while the window is open, then the exception closes for good
 * (docs/runbooks/ecosystem-moderation.md).
 */

import { envInt, createLogger, SYSTEM_ACTOR_ID } from '@pipeline-builder/api-core';
import { OFFICIAL_PUBLISHER_HANDLE, type PluginPublishRequest, type Publisher } from '@pipeline-builder/pipeline-data';

import { isOfficialLoader, type Caller } from './context.js';
import { atomically, listings, settings } from './store.js';

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
  return envInt('ECOSYSTEM_BOOTSTRAP_WINDOW_HOURS', 24, { min: 1 }) * 3_600_000;
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
    return true;
  });
  if (closed) logger.info('Ecosystem bootstrap exception closed', { reason });
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
    if ((await listings.countAll()) > 0) {
      await closeBootstrap('listings_exist', SYSTEM_ACTOR_ID);
      return false;
    }
    // Open it under the row lock: a concurrent opener must not reset a count.
    return atomically(async () => {
      const cur = (await settings.getForUpdate<BootstrapState>(BOOTSTRAP_KEY)) ?? state;
      if (cur.closedAt) return false;
      if (!cur.openedAt) await settings.put(BOOTSTRAP_KEY, { ...cur, openedAt: new Date().toISOString() }, SYSTEM_ACTOR_ID);
      return true;
    });
  }
  if (Date.now() - new Date(state.openedAt).getTime() > bootstrapWindowMs()) {
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
