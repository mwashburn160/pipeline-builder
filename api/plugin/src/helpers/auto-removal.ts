// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * What NO automatic process may remove: a plugin version that is ACTIVE, or a
 * plugin's ONLY remaining version (counting the non-deleted versions of that
 * name in that org) — nor either one's kept source in plugin-sources.
 *
 * "Automatic" is every clean-up nobody asked for by name: the soft-delete purge
 * sweep, the retry of failed source / image deletes, and the superseded-version
 * retention pass (and its dry run, which reports such a version as kept with
 * the reason). An owner's explicit action — `DELETE /plugins/:id`, the by-name
 * delete / purge, `POST /plugins/:id/purge`, the org purge — is not automatic
 * and is unaffected.
 *
 * One predicate ({@link autoRemovalProtection}) and its SQL twin
 * ({@link autoRemovalProtectedSql}) so every path asks the same question; a
 * skip is counted in `plugin_auto_removal_skipped_total{reason}` (reason ∈
 * `active` | `only_version`).
 */

import { createLogger } from '@pipeline-builder/api-core';
import { sql, type SQL } from 'drizzle-orm';

const logger = createLogger('plugin-auto-removal');

/** Why an automatic process must leave a version (and its kept source) alone. */
export const AUTO_REMOVAL_PROTECTIONS = ['active', 'only_version'] as const;
export type AutoRemovalProtection = typeof AUTO_REMOVAL_PROTECTIONS[number];

/** What the predicate reads about one version. */
export interface AutoRemovalFacts {
  /** `plugins.is_active`. */
  isActive: boolean;
  /** `plugins.deleted_at` (a tombstone is never active, whatever `is_active` says). */
  deletedAt: Date | string | null;
  /** Non-deleted versions of the same name in the same org, OTHER than this one. */
  otherLiveVersions: number;
}

/**
 * Why `v` is protected from automatic removal, or null when it is not:
 * - `active`: a live (non-deleted) version that is active;
 * - `only_version`: no OTHER non-deleted version of the name remains — removing
 *   it (or, for a tombstone, purging it) would leave the org with none.
 */
export function autoRemovalProtection(v: AutoRemovalFacts): AutoRemovalProtection | null {
  if (v.isActive && v.deletedAt === null) return 'active';
  if (v.otherLiveVersions <= 0) return 'only_version';
  return null;
}

/** Shorthand: whether {@link autoRemovalProtection} protects `v`. */
export function isProtectedFromAutoRemoval(v: AutoRemovalFacts): boolean {
  return autoRemovalProtection(v) !== null;
}

/** Count (and log) an automatic removal that was skipped. */
export function recordAutoRemovalSkip(reason: AutoRemovalProtection, context: { path: string; orgId?: string; name?: string; version?: string }, count = 1): void {
  // Lazily: this module is on the plugin service's import graph, which some
  // suites load without the metrics stack. Best-effort, like every counter.
  void import('@pipeline-builder/api-server').then(({ incCounter }) => incCounter('plugin_auto_removal_skipped_total', { reason }, count)).catch(() => undefined);
  logger.info('Automatic removal skipped: the version is protected', { reason, count, ...context });
}

/**
 * The same rule as SQL over a `plugins` row alias: TRUE when the row is
 * protected. `row` is the alias the caller's query uses (e.g. sql`pr`); the
 * subquery uses `sib`, so the caller's alias must not be that.
 */
export function autoRemovalProtectedSql(row: SQL): SQL {
  return sql`(
    (${row}.is_active AND ${row}.deleted_at IS NULL)
    OR NOT EXISTS (
      SELECT 1 FROM plugins sib
       WHERE sib.org_id = ${row}.org_id AND sib.name = ${row}.name
         AND sib.id <> ${row}.id AND sib.deleted_at IS NULL
    )
  )`;
}

/** The protection reason as SQL (NULL when unprotected), for reports. */
export function autoRemovalReasonSql(row: SQL): SQL {
  return sql`CASE
    WHEN ${row}.is_active AND ${row}.deleted_at IS NULL THEN 'active'
    WHEN NOT EXISTS (
      SELECT 1 FROM plugins sib
       WHERE sib.org_id = ${row}.org_id AND sib.name = ${row}.name
         AND sib.id <> ${row}.id AND sib.deleted_at IS NULL
    ) THEN 'only_version'
    ELSE NULL END`;
}
