// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * What became of an org plugin a reference names but lookup did not resolve:
 * `deleted`, `inactive`, `yanked`, `missing` — or `live` when a row would have
 * resolved under a different filter. A 404 that says only "not found" sends a
 * pipeline owner hunting; "deleted in your org" says what to do (restore it).
 *
 * Reads the caller's own org and, for a team, its root org's rows (elevated,
 * scoped by the explicit org ids — the parent's rows sit outside the caller's RLS).
 */

import { anyText, executeRows, isVersionRange, scopeOrgIds, type ResolutionScope } from '@pipeline-builder/pipeline-data';
import { sql } from 'drizzle-orm';

import { elevated } from './ecosystem/store.js';

/** The state a lookup 404 carries in `details.state`. */
export type PluginRowState = 'live' | 'deleted' | 'inactive' | 'yanked' | 'missing';

/** The state of the org rows `filter` names (by id, or by name and an exact version). */
export async function pluginRowState(scope: ResolutionScope, filter: { id?: unknown; name?: unknown; version?: unknown }): Promise<PluginRowState> {
  const orgIds = scopeOrgIds(scope);
  const byId = typeof filter.id === 'string' && filter.id.length > 0;
  if (!byId && typeof filter.name !== 'string') return 'missing';
  const exact = typeof filter.version === 'string' && !isVersionRange(filter.version) ? filter.version.trim() : null;
  const rows = await elevated((tx) => executeRows<{ deleted: boolean; active: boolean; yanked: boolean }>(tx, sql`
    SELECT deleted_at IS NOT NULL AS deleted, is_active AS active, yanked_at IS NOT NULL AS yanked
      FROM plugins
     WHERE lower(org_id) = ${anyText(orgIds)}
       AND ${byId ? sql`id::text = ${filter.id as string}` : sql`name = ${filter.name as string}`}
       ${exact && !byId ? sql`AND version = ${exact}` : sql``}
     LIMIT 200
  `)).catch(() => []);
  if (rows.length === 0) return 'missing';
  const live = rows.filter((r) => !r.deleted);
  if (live.some((r) => r.active && !r.yanked)) return 'live';
  if (live.some((r) => r.yanked)) return 'yanked';
  if (live.length > 0) return 'inactive';
  return 'deleted';
}
