// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * WHO automatic tidying may touch: one org's live plugin versions, each with
 * the first protection that holds it. A version qualifies only when NONE does:
 *
 *  - `managed` — a managed toolchain name (its releases have their own lifecycle);
 *  - `never_tidy` — the org set the plugin to never tidy;
 *  - `only_version` — the name's only live version (helpers/auto-removal.ts);
 *  - `inactive_by_owner` — its owner deactivated it; tidying leaves that alone;
 *  - `default` / `latest` — the plugin's default, its newest version or its newest stable one;
 *  - `frozen` — a publish request references it;
 *  - `remediation_pending` — a live remediation of (or to) it, or a pending
 *    remediation rollout / proposal moving a pipeline from or to it;
 *  - `install_pin` — an install of a listing published from it pins, resolved
 *    or is about to move to that version;
 *  - `listed_in_use` — a pipeline references the listing's copy of it;
 *  - `kev_accepted` — it carries a CISA KEV finding and an active risk
 *    acceptance covers it: kept as a rollback target;
 *  - `in_use` — any pipeline references it (declared resolution, deployed step
 *    manifest, open exposure, or a pipeline config naming it), through the
 *    delete path's own check (`pluginService.deleteBlockers`).
 *
 * Every unanswerable check keeps the version.
 */

import { compareSemverLenient, isManagedToolchainPlugin, parseSemver, TERMINAL_REMEDIATION_STAGES, versionScanFacts } from '@pipeline-builder/api-core';
import { executeRows, schema, versionReferencedPredicate, type Plugin } from '@pipeline-builder/pipeline-data';
import { and, eq, isNull, sql } from 'drizzle-orm';

import { DAY_MS, TIDY_WARN_DAYS } from './config.js';
import { staleAt, type TidyClock, type TidySkipReason } from './decide.js';
import type { TidySettings } from './settings.js';
import { elevated } from '../ecosystem/store.js';
import { pluginService } from '../plugin-service.js';

/** One live version with its clock and the first protection holding it. */
export interface TidyVersionFacts {
  row: Plugin;
  clock: TidyClock;
  /** A listing version was published from it (its retirement needs `force`). */
  listed: boolean;
  protection: TidySkipReason | null;
}

interface FlagRow {
  id: string;
  install_pin: boolean;
  listing_referenced: boolean;
  listed: boolean;
  remediation_pending: boolean;
  accepted: boolean;
}

const asDate = (v: Date | string | null | undefined): Date | null => (v === null || v === undefined ? null : v instanceof Date ? v : new Date(v));

/** The org's live rows (managed names included: they are reported as `managed`). */
async function liveRows(orgId: string): Promise<Plugin[]> {
  const p = schema.plugin;
  return elevated((tx) => tx.select().from(p).where(and(eq(p.orgId, orgId), isNull(p.deletedAt)))) as Promise<Plugin[]>;
}

/** The SQL-answered protections, per row id. */
async function flagsOf(ids: readonly string[], now: Date): Promise<Map<string, FlagRow>> {
  if (ids.length === 0) return new Map();
  const listingRef = versionReferencedPredicate({ digest: sql`lv.image_digest`, name: sql`NULL`, version: sql`NULL`, orgId: sql`NULL` });
  const rows = await elevated((tx) => executeRows<FlagRow>(tx, sql`
    SELECT p.id,
           EXISTS (SELECT 1 FROM plugin_listing_versions lv WHERE lv.source_plugin_id = p.id) AS listed,
           EXISTS (SELECT 1 FROM plugin_listing_versions lv
                     JOIN plugin_installs i ON i.listing_id = lv.listing_id AND i.status <> 'denied'
                    WHERE lv.source_plugin_id = p.id
                      AND (i.pinned_version = lv.version OR i.resolved_version = lv.version OR i.pending_change->>'version' = lv.version)) AS install_pin,
           EXISTS (SELECT 1 FROM plugin_listing_versions lv
                    WHERE lv.source_plugin_id = p.id AND lv.image_digest IS NOT NULL AND ${listingRef}) AS listing_referenced,
           (EXISTS (SELECT 1 FROM plugin_remediations rm
                     WHERE (rm.plugin_id = p.id OR rm.to_plugin_id = p.id) AND rm.stage NOT IN (${sql.join(TERMINAL_REMEDIATION_STAGES.map((s) => sql`${s}`), sql`, `)}))
            OR EXISTS (SELECT 1 FROM pipeline_remediation_upgrades u
                        WHERE u.plugin_name = p.name AND u.plugin_publisher IS NULL
                          AND (u.from_version = p.version OR u.to_version = p.version)
                          AND u.state IN ('proposed', 'change_requested', 'queued'))) AS remediation_pending,
           EXISTS (SELECT 1 FROM plugin_vuln_exposure e
                    WHERE e.triage_state = 'accepted' AND (e.accepted_until IS NULL OR e.accepted_until > ${now})
                      AND ((p.image_digest IS NOT NULL AND e.image_digest = p.image_digest)
                           OR (e.plugin_name = p.name AND e.plugin_version = p.version AND e.plugin_publisher IS NULL AND lower(e.org_id) = lower(p.org_id)))) AS accepted
      FROM plugins p
     WHERE p.id IN (${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)})`));
  return new Map(rows.map((r) => [r.id, r]));
}

const isYanked = (r: Plugin): boolean => r.yankedAt !== null || r.lifecycle === 'yanked';
const isStable = (v: string): boolean => (parseSemver(v)?.prerelease.length ?? 1) === 0;

/** Per name: the newest live version and the newest live stable one (not yanked). */
function newestOf(rows: readonly Plugin[]): Set<string> {
  const byName = new Map<string, Plugin[]>();
  for (const r of rows) if (!isYanked(r)) byName.set(r.name, [...(byName.get(r.name) ?? []), r]);
  const keep = new Set<string>();
  for (const versions of byName.values()) {
    const sorted = [...versions].sort((a, b) => compareSemverLenient(b.version, a.version));
    if (sorted[0]) keep.add(sorted[0].id);
    const stable = sorted.find((r) => isStable(r.version));
    if (stable) keep.add(stable.id);
  }
  return keep;
}

export function clockOf(r: Pick<Plugin, 'createdAt' | 'lastUsedAt' | 'tidyKeptAt' | 'tidyWarnedAt' | 'tidyDeactivateAfter' | 'tidyDeactivatedAt'>): TidyClock {
  return {
    createdAt: asDate(r.createdAt)!,
    lastUsedAt: asDate(r.lastUsedAt),
    keptAt: asDate(r.tidyKeptAt),
    warnedAt: asDate(r.tidyWarnedAt),
    deactivateAfter: asDate(r.tidyDeactivateAfter),
    deactivatedAt: asDate(r.tidyDeactivatedAt),
  };
}

/**
 * Every live version of `orgId` with its protection. The delete path's
 * reference check (the expensive one) runs only for versions that need an
 * answer today: within a week of stale, already warned, or tidy-deactivated.
 */
export async function orgVersionFacts(orgId: string, settings: TidySettings, now: Date): Promise<TidyVersionFacts[]> {
  const rows = await liveRows(orgId);
  const flags = await flagsOf(rows.map((r) => r.id), now);
  const newest = newestOf(rows);
  const never = new Set(settings.neverTidy);
  const liveByName = new Map<string, number>();
  for (const r of rows) liveByName.set(r.name, (liveByName.get(r.name) ?? 0) + 1);

  const out: TidyVersionFacts[] = [];
  for (const row of rows) {
    const clock = clockOf(row);
    const f = flags.get(row.id);
    let protection: TidySkipReason | null =
      isManagedToolchainPlugin(row.name) ? 'managed'
        : never.has(row.name) ? 'never_tidy'
          : (liveByName.get(row.name) ?? 0) <= 1 ? 'only_version'
            : !row.isActive && !clock.deactivatedAt ? 'inactive_by_owner'
              : row.isDefault ? 'default'
                : newest.has(row.id) ? 'latest'
                  : row.frozenAt ? 'frozen'
                    : !f ? 'in_use' // unanswerable: keep
                      : f.remediation_pending ? 'remediation_pending'
                        : f.install_pin ? 'install_pin'
                          : f.listing_referenced ? 'listed_in_use'
                            : f.accepted && versionScanFacts({ ...row, ownerOrgId: row.orgId } as never).kev > 0 ? 'kev_accepted'
                              : null;
    const needsAnswer = clock.deactivatedAt !== null || clock.warnedAt !== null
      || now.getTime() >= staleAt(clock, settings.staleAfterDays).getTime() - TIDY_WARN_DAYS * DAY_MS;
    if (protection === null && needsAnswer) {
      try {
        const blockers = await pluginService.deleteBlockers(row, orgId);
        if (blockers.frozen) protection = 'frozen';
        else if (blockers.inUse > 0) protection = 'in_use';
      } catch {
        protection = 'in_use'; // unanswerable: keep
      }
    }
    out.push({ row, clock, listed: f?.listed ?? false, protection });
  }
  return out;
}
