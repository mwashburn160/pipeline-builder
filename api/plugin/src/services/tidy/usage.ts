// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * What restarts a version's tidy clock: a USE (a `/plugins/lookup` that
 * resolved it — synth and the pipeline service's save-time check both resolve
 * through it), the owner's KEEP, and a restore (plugin-service's
 * `restoreExtraSet`). Each clears a pending warning and reactivates a version
 * tidying deactivated.
 *
 * A use is a hot-path write, so it is throttled: at most one `last_used_at`
 * write an hour per version (an in-process map skips even the UPDATE, and the
 * UPDATE's own predicate is the cross-replica guard), unless the version
 * carries tidy state, which a use clears at once. The stamp never moves
 * `updated_at` (the plugins modtime trigger ignores a `last_used_at`-only
 * change), so an editor's optimistic-concurrency token stays valid.
 *
 * Registry pulls are NOT counted: image-registry serves pulls by digest with
 * no per-pull hook to this service, and a deployed pipeline's pulls already
 * hold the version through its step manifest (`in_use`).
 */

import { createLogger, ErrorCode, errorMessage, recordAudit, SYSTEM_ACTOR_ID } from '@pipeline-builder/api-core';
import { incCounter } from '@pipeline-builder/api-server';
import { schema, type Plugin } from '@pipeline-builder/pipeline-data';
import { and, eq, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';

import { TIDY_NEVER_MAX_NAMES, TIDY_USE_THROTTLE_MS } from './config.js';
import { isPluginName, readTidySettings, writeTidySettings, type TidySettings } from './settings.js';
import { EcosystemError } from '../ecosystem/context.js';
import { elevated } from '../ecosystem/store.js';
import { pluginService } from '../plugin-service.js';

const logger = createLogger('plugin-tidy');
const p = () => schema.plugin;

/** The columns a clock restart writes (and the reactivation of a tidy-deactivated version). */
export function clockRestartSet(): Record<string, unknown> {
  return {
    tidyWarnedAt: null,
    tidyDeactivateAfter: null,
    isActive: sql`CASE WHEN ${p().tidyDeactivatedAt} IS NOT NULL THEN true ELSE ${p().isActive} END`,
    tidyDeactivatedAt: null,
  };
}

const lastWrite = new Map<string, number>();
const MAX_TRACKED = 10_000;

/** Test hook: forget the in-process throttle. */
export function resetUseThrottleForTests(): void {
  lastWrite.clear();
}

/**
 * Stamp `row` as used now. Best-effort and never throws: a lookup must not
 * fail on bookkeeping.
 */
export async function recordPluginUse(row: Pick<Plugin, 'id'> & Partial<Pick<Plugin, 'tidyWarnedAt' | 'tidyDeactivatedAt'>>, now: Date = new Date()): Promise<void> {
  const tidyState = !!row.tidyWarnedAt || !!row.tidyDeactivatedAt;
  const seen = lastWrite.get(row.id);
  if (!tidyState && seen !== undefined && now.getTime() - seen < TIDY_USE_THROTTLE_MS) return;
  if (lastWrite.size >= MAX_TRACKED) lastWrite.clear();
  lastWrite.set(row.id, now.getTime());
  try {
    const cutoff = new Date(now.getTime() - TIDY_USE_THROTTLE_MS);
    const updated = await elevated((tx) => tx.update(p())
      .set({ lastUsedAt: now, ...clockRestartSet() })
      .where(and(
        eq(p().id, row.id),
        isNull(p().deletedAt),
        or(isNull(p().lastUsedAt), lt(p().lastUsedAt, cutoff), isNotNull(p().tidyWarnedAt), isNotNull(p().tidyDeactivatedAt)),
      ))
      .returning()) as Plugin[];
    if (tidyState && updated[0]) await pluginService.afterManagedWrite(updated, SYSTEM_ACTOR_ID);
  } catch (err) {
    lastWrite.delete(row.id);
    incCounter('plugin_tidy_failed_total', { stage: 'use_stamp' });
    logger.warn('Plugin version use not stamped', { id: row.id, error: errorMessage(err) });
  }
}

/**
 * The owner's Keep: restart `pluginId`'s clock (a deactivated version is
 * active again). Only a live version of `orgId` itself; null otherwise.
 */
export async function keepVersion(orgId: string, pluginId: string, userId: string, now: Date = new Date()): Promise<Plugin | null> {
  const org = orgId.toLowerCase();
  const rows = await elevated((tx) => tx.update(p())
    .set({ tidyKeptAt: now, ...clockRestartSet() })
    .where(and(eq(p().id, pluginId), eq(p().orgId, org), isNull(p().deletedAt)))
    .returning()) as Plugin[];
  const row = rows[0];
  if (!row) return null;
  await pluginService.afterManagedWrite([row], userId);
  incCounter('plugin_tidy_versions_total', { outcome: 'kept' });
  recordAudit({
    action: 'plugin.tidy.kept',
    actorId: userId || SYSTEM_ACTOR_ID,
    orgId: org,
    targetType: 'plugin',
    targetId: row.id,
    details: { pluginName: row.name, version: row.version, scope: 'version' },
  });
  return row;
}

/**
 * Set (or clear) a plugin's "never tidy". Turning it on reactivates the
 * name's tidy-deactivated versions at once and drops their warnings.
 *
 * Adding a name is refused (400 VALIDATION_ERROR) unless it is lowercase, names
 * a plugin the org has a live version of, and the list stays within
 * {@link TIDY_NEVER_MAX_NAMES}. Clearing a name is always allowed (a name whose
 * plugin has since been deleted can still come off the list).
 */
export async function setNeverTidy(orgId: string, name: string, never: boolean, userId: string): Promise<TidySettings> {
  const org = orgId.toLowerCase();
  const current = await readTidySettings(org);
  const names = new Set(current.neverTidy);
  if (never && !names.has(name)) {
    if (!isPluginName(name)) throw new EcosystemError(ErrorCode.VALIDATION_ERROR, 'A never-tidy name must be a lowercase plugin name.', { name });
    if (names.size >= TIDY_NEVER_MAX_NAMES) {
      throw new EcosystemError(ErrorCode.VALIDATION_ERROR, `The never-tidy list holds at most ${TIDY_NEVER_MAX_NAMES} plugins; clear one first.`, { max: TIDY_NEVER_MAX_NAMES });
    }
    const exists = await elevated((tx) => tx.select({ id: p().id }).from(p())
      .where(and(eq(p().orgId, org), eq(p().name, name), isNull(p().deletedAt))).limit(1));
    if (exists.length === 0) throw new EcosystemError(ErrorCode.VALIDATION_ERROR, `Your organization has no plugin named "${name}".`, { name });
  }
  if (never) names.add(name); else names.delete(name);
  const settings = await writeTidySettings(org, { neverTidy: [...names].sort() }, userId);
  if (never) {
    const rows = await elevated((tx) => tx.update(p())
      .set(clockRestartSet())
      .where(and(eq(p().orgId, org), eq(p().name, name), isNull(p().deletedAt), or(isNotNull(p().tidyWarnedAt), isNotNull(p().tidyDeactivatedAt))))
      .returning()) as Plugin[];
    if (rows.length > 0) await pluginService.afterManagedWrite(rows, userId);
  }
  recordAudit({
    action: 'plugin.tidy.kept',
    actorId: userId || SYSTEM_ACTOR_ID,
    orgId: org,
    targetType: 'plugin',
    targetId: name,
    details: { pluginName: name, scope: 'plugin', neverTidy: never },
  });
  return settings;
}
