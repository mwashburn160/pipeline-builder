// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * WHICH superseded system plugin versions may be retired — the selection half
 * of the retention pass (retire.ts acts on it; the dry run reports it).
 *
 * The unit is one system-org plugin name and, when it is listed, its Official
 * listing. Managed toolchain names (`pipeline-bootstrap`, `cdk-synth`) are never
 * considered: releases have their own lifecycle in the Toolchain console.
 *
 * A version is RETIRABLE only when every one of these holds; each rule names
 * itself in the report when it keeps a version:
 *
 *  - It is outside the newest `keep` LIVE versions of its own major, by semver
 *    (`within_keep`). Live = not yanked, not soft-deleted, and not deprecated
 *    by anyone but this pass. The newest non-yanked stable version of EVERY
 *    major is always kept (`newest_in_major`) — the lowest one being the
 *    implicit Official install's range (`implicit_install`) — so retention never
 *    moves an implicit install across a major. A prerelease never counts toward
 *    `keep`, and is kept while no live stable version of its major is newer
 *    (`prerelease_ahead_of_stable`).
 *  - No explicit install depends on it: an install's exact pin
 *    (`install_pinned`), its last resolved version (`install_resolved`), the
 *    version a pending install change asks for (`install_pending_change`), and
 *    the newest version its policy admits (`install_newest_admitted`).
 *  - It is not the default version (`default_version`); a protected floating
 *    tag pointing at its digest is refused registry-side when the image is
 *    collected.
 *  - No pipeline in any org references it, by the rule every removal path asks
 *    (`pipeline_reference`: a live pipeline's declared resolution, any deployed
 *    step manifest — a soft-deleted pipeline's included — or an open deployed
 *    exposure), for its system image and for its public copy.
 *  - No soft-deleted pipeline resolved or pins it (`deleted_pipeline_pin`, from
 *    its kept resolution rows and its stored config), and no template pins it
 *    exactly (`template_pin`, from the stored config).
 *  - Its listed version is not paused (`paused`).
 *  - It is not protected from AUTOMATIC removal (helpers/auto-removal.ts): an
 *    ACTIVE version (`active`) and a name's only remaining version
 *    (`only_version`) are never retired — kept, and an earlier deprecation of
 *    this pass reversed — so the dry run reports them with that reason.
 *  - Every live pipeline declaring the plugin has resolution rows after a
 *    synchronous, uncapped refresh; one that still has none holds EVERY version
 *    of the plugin for the pass (`declared_without_resolution`), and so does a
 *    refresh that could not finish (`resolution_refresh_incomplete`).
 *
 * The ordering rules are the pure {@link decidePlugin}; the reference rules are
 * one SQL expression ({@link retentionHoldSql}) evaluated per row. Every
 * unanswerable check keeps the version.
 */

import { isManagedToolchainPlugin, SYSTEM_ORG_ID, compareSemverLenient, parseSemver } from '@pipeline-builder/api-core';
import {
  executeRows,
  implicitInstallRange,
  installAdmits,
  managedToolchainNamesSql,
  OFFICIAL_PUBLISHER_HANDLE,
  versionReferencedPredicate,
  type InstallVersionPolicy,
} from '@pipeline-builder/pipeline-data';
import { sql, type SQL } from 'drizzle-orm';

import { autoRemovalReasonSql, type AutoRemovalProtection } from '../../helpers/auto-removal.js';

// -----------------------------------------------------------------------------
// The pure decision
// -----------------------------------------------------------------------------

/** One live (not soft-deleted) system row of the plugin, with what the SQL found. */
export interface VersionFacts {
  pluginId: string;
  version: string;
  digest: string | null;
  yanked: boolean;
  deprecated: boolean;
  /** This pass's own retirement record: deprecated by retention, awaiting the yank. */
  retirement: { deprecatedAt: Date } | null;
  /** The first reference rule that holds the version (see the module doc), or null. */
  held: string | null;
  /** Protected from automatic removal (active, or the name's only version); absent = not protected. */
  protection?: AutoRemovalProtection | null;
  /** The Official listing's copy of this version, when listed. */
  listing: { id: string; digest: string | null; repository: string | null; yanked: boolean; deprecated: boolean } | null;
}

/** An explicit install of the plugin's listing (denied installs excluded). */
export interface InstallFacts {
  versionPolicy: InstallVersionPolicy;
  pinnedVersion: string | null;
  resolvedVersion: string | null;
  pendingChange: { version: string; versionPolicy: InstallVersionPolicy } | null;
}

/** A listed version as the install rules read it. */
export interface ListedVersionRow {
  version: string;
  yankedAt: Date | null;
  pausedAt: Date | null;
  breaking: boolean;
}

/**
 * What the pass does with one version:
 *  - `keep` — retained (`rule` says why);
 *  - `deprecate` — retirable and not yet in its notice period: deprecated now;
 *  - `notice` — deprecated by an earlier pass, notice period still running;
 *  - `yank` — notice period over and still retirable: yanked and soft-deleted now;
 *  - `reverse` — deprecated by an earlier pass but no longer retirable: the
 *    deprecation is reversed (`rule` says what holds it now);
 *  - `refused` — retirable, but the plugin was refused for this pass because
 *    its declared-resolution refresh did not finish (plan.ts sets it).
 */
export type RetentionState = 'keep' | 'deprecate' | 'notice' | 'yank' | 'reverse' | 'refused';

/** One version's decision. */
export interface VersionDecision {
  pluginId: string;
  version: string;
  digest: string | null;
  state: RetentionState;
  /** Why it is kept, or why it is retirable. */
  rule: string;
  /**
   * A `deprecate` the per-plugin throttle held back to a later pass: at most
   * `floor(maxFraction × live versions)` (at least one) are newly deprecated
   * per plugin per pass, oldest first.
   */
  deferred?: boolean;
  /** When this pass deprecated it (its notice period started). */
  deprecatedAt?: Date;
  /** When the notice period ends. */
  yankAfter?: Date;
}

export interface DecideInput {
  versions: readonly VersionFacts[];
  installs: readonly InstallFacts[];
  /** The listing's versions (empty when the plugin is not listed). */
  listed: readonly ListedVersionRow[];
  keep: number;
  noticeDays: number;
  maxFraction: number;
  now: Date;
  /** A reason that holds EVERY version this pass (the declared-resolution rule). */
  holdAll?: string | null;
}

export interface PluginDecision {
  decisions: VersionDecision[];
  /** Versions not yanked (the denominator of the safety limit). */
  liveCount: number;
  /** Versions this pass would retire or is retiring (deprecate, notice, yank). */
  retireCount: number;
  /** Newly deprecated versions the throttle defers to a later pass. */
  deferredCount: number;
  /** Set when the plugin is refused this pass (plan.ts: `resolution_refresh_incomplete`). */
  refusedReason?: string;
}

const DAY_MS = 86_400_000;

const isStable = (v: string): boolean => (parseSemver(v)?.prerelease.length ?? 1) === 0;
const majorOf = (v: string): number | null => parseSemver(v)?.major ?? null;
const newestFirst = (a: { version: string }, b: { version: string }) => compareSemverLenient(b.version, a.version);

/** Why the ordering rules keep each version (absent = outside every keep). */
function orderingKeeps(versions: readonly VersionFacts[], keep: number): Map<string, string> {
  const kept = new Map<string, string>();
  const nonYankedStable = versions.filter((v) => !v.yanked && isStable(v.version));
  const majors = [...new Set(nonYankedStable.map((v) => majorOf(v.version)!))];
  // The implicit Official install's range — the lowest live major — through the
  // resolver's own function, over the same rows.
  const implicit = implicitInstallRange(versions.map((v) => ({ version: v.version, yankedAt: v.yanked ? new Date(0) : null, pausedAt: null, breaking: false })));
  for (const major of majors) {
    const inMajor = nonYankedStable.filter((v) => majorOf(v.version) === major).sort(newestFirst);
    const newest = inMajor[0]!;
    kept.set(newest.version, implicit === `${major}.x` ? 'implicit_install' : 'newest_in_major');
    // Counted toward `keep`: live, i.e. not deprecated by anyone but this pass.
    const counted = inMajor.filter((v) => !v.deprecated || v.retirement !== null).slice(0, keep);
    for (const v of counted) if (!kept.has(v.version)) kept.set(v.version, 'within_keep');
  }
  // A prerelease is kept while no live stable version of its major is newer.
  for (const v of versions) {
    if (v.yanked || isStable(v.version)) continue;
    const major = majorOf(v.version);
    const overtaken = nonYankedStable.some((s) => majorOf(s.version) === major && compareSemverLenient(s.version, v.version) > 0);
    if (!overtaken) kept.set(v.version, 'prerelease_ahead_of_stable');
  }
  return kept;
}

/** Versions the listing's explicit installs need (see the module doc). */
function installKeeps(installs: readonly InstallFacts[], listed: readonly ListedVersionRow[]): Map<string, string> {
  const kept = new Map<string, string>();
  const live = listed.filter((v) => !v.yankedAt);
  const newestAdmitted = (policy: InstallVersionPolicy, pinnedVersion: string | null): string | null => {
    const admitted = live.filter((v) => installAdmits({ versionPolicy: policy, pinnedVersion }, v.version, listed)).sort(newestFirst);
    return admitted[0]?.version ?? null;
  };
  const add = (version: string | null, rule: string) => { if (version && !kept.has(version)) kept.set(version, rule); };
  for (const i of installs) {
    if (i.versionPolicy === 'pinned') add(i.pinnedVersion, 'install_pinned');
    add(i.resolvedVersion, 'install_resolved');
    add(i.pendingChange?.version ?? null, 'install_pending_change');
    add(newestAdmitted(i.versionPolicy, i.pinnedVersion), 'install_newest_admitted');
    if (i.pendingChange) add(newestAdmitted(i.pendingChange.versionPolicy, i.pendingChange.version), 'install_newest_admitted');
  }
  return kept;
}

/**
 * Decide every version of one plugin. Pure: the reference rules arrive as
 * `held` on each version (or `holdAll`), so this is only ordering, installs,
 * the notice period and the safety limit.
 */
export function decidePlugin(input: DecideInput): PluginDecision {
  const ordering = orderingKeeps(input.versions, input.keep);
  const installs = installKeeps(input.installs, input.listed);
  const noticeMs = input.noticeDays * DAY_MS;

  const decisions: VersionDecision[] = [...input.versions].sort(newestFirst).map((v) => {
    const base = { pluginId: v.pluginId, version: v.version, digest: v.digest };
    if (v.yanked) {
      // Yanked by this pass, but the soft-delete did not land: finish it —
      // unless the version is protected from automatic removal now.
      if (v.retirement && v.protection) return { ...base, state: 'keep' as const, rule: v.protection };
      return v.retirement
        ? { ...base, state: 'yank' as const, rule: 'finish_retirement', deprecatedAt: v.retirement.deprecatedAt }
        : { ...base, state: 'keep' as const, rule: 'already_yanked' };
    }
    // Last: no automatic process removes an active version or a name's last one.
    const keptBy = ordering.get(v.version) ?? installs.get(v.version) ?? input.holdAll ?? v.held ?? v.protection ?? null;
    if (keptBy) {
      return v.retirement
        ? { ...base, state: 'reverse' as const, rule: keptBy, deprecatedAt: v.retirement.deprecatedAt }
        : { ...base, state: 'keep' as const, rule: keptBy };
    }
    const rule = isStable(v.version) ? 'superseded_in_major' : 'superseded_prerelease';
    if (!v.retirement) return { ...base, state: 'deprecate' as const, rule };
    const yankAfter = new Date(v.retirement.deprecatedAt.getTime() + noticeMs);
    return { ...base, state: input.now >= yankAfter ? 'yank' as const : 'notice' as const, rule, deprecatedAt: v.retirement.deprecatedAt, yankAfter };
  });

  const liveCount = input.versions.filter((v) => !v.yanked || v.retirement !== null).length;
  const retiring = decisions.filter((d) => d.state === 'deprecate' || d.state === 'notice' || d.state === 'yank');
  // The throttle: newly deprecate at most floor(maxFraction × live) versions
  // (at least one), oldest first; the rest wait for a later pass. Deprecation is
  // reversible and nothing is yanked before its notice period, so this bounds
  // what a selection bug could start in one pass without stalling a plugin with
  // a long history. Yanks of versions already through their notice are not
  // throttled here (the pass's batch caps them).
  const fresh = decisions.filter((d) => d.state === 'deprecate').reverse();
  const allowed = Math.max(1, Math.floor(input.maxFraction * liveCount));
  for (const d of fresh.slice(allowed)) d.deferred = true;
  return { decisions, liveCount, retireCount: retiring.length, deferredCount: Math.max(0, fresh.length - allowed) };
}

// -----------------------------------------------------------------------------
// The reference rules, as SQL
// -----------------------------------------------------------------------------

const OFFICIAL = OFFICIAL_PUBLISHER_HANDLE;
const SYSTEM = SYSTEM_ORG_ID.toLowerCase();

/** `LATERAL (…) AS refs`: one `ref` per plugin reference of the props column `props` (every stage step's plugin, plus synth's). */
function pluginRefsOf(props: SQL): SQL {
  return sql`LATERAL (
      SELECT step->'plugin' AS ref
        FROM jsonb_array_elements(COALESCE(${props}->'stages', '[]'::jsonb)) AS stage,
             jsonb_array_elements(COALESCE(stage->'steps', '[]'::jsonb)) AS step
      UNION ALL
      SELECT ${props}->'synth'->'plugin'
    ) AS refs`;
}

/** A reference that names this plugin: by name, unqualified or through the Official publisher. */
const namesPlugin = (name: SQL) => sql`ref->>'name' = ${name} AND COALESCE(ref->>'publisher', '') IN ('', ${OFFICIAL})`;

/**
 * The columns {@link retentionHoldSql} reads, as SQL over the caller's row.
 * The caller's row alias must not be `p`, `r`, `m`, `e`, `dp` or `t`: the
 * reference subqueries use those for pipelines and their resolution,
 * manifest and exposure rows, and would shadow it.
 */
export interface HoldColumns {
  name: SQL;
  version: SQL;
  /** The system image digest (NULL when none). */
  digest: SQL;
  /** The public copy's digest (NULL when not listed). */
  publicDigest: SQL;
  isDefault: SQL;
  /** The listed version's pause (NULL when not listed or not paused). */
  pausedAt: SQL;
}

/**
 * The first reference rule holding a version, or NULL when none does: the
 * default, a paused listing, a pipeline reference (system image or public
 * copy), a soft-deleted pipeline's resolution or exact pin, a template's exact
 * pin, or a managed toolchain name. Run elevated (every org's pipelines count).
 */
export function retentionHoldSql(c: HoldColumns): SQL {
  const referenced = versionReferencedPredicate({ digest: c.digest, name: c.name, version: c.version, orgId: sql`${SYSTEM}` });
  const publicReferenced = versionReferencedPredicate({ digest: c.publicDigest, name: sql`NULL`, version: sql`NULL`, orgId: sql`NULL` });
  return sql`CASE
    WHEN ${c.name} IN (${managedToolchainNamesSql}) THEN 'managed_toolchain'
    WHEN ${c.isDefault} THEN 'default_version'
    WHEN ${c.pausedAt} IS NOT NULL THEN 'paused'
    WHEN ${referenced} THEN 'pipeline_reference'
    WHEN ${c.publicDigest} IS NOT NULL AND ${publicReferenced} THEN 'pipeline_reference'
    WHEN EXISTS (
      SELECT 1 FROM pipeline_plugin_resolution r
        JOIN pipelines dp ON dp.id::text = r.pipeline_id AND dp.deleted_at IS NOT NULL
       WHERE r.plugin_name = ${c.name} AND (r.plugin_publisher IS NULL OR r.plugin_publisher = ${OFFICIAL})
         AND (r.resolved_version = ${c.version} OR r.declared_version = ${c.version}
              OR (${c.digest} IS NOT NULL AND r.resolved_digest = ${c.digest})
              OR (${c.publicDigest} IS NOT NULL AND r.resolved_digest = ${c.publicDigest})))
      OR EXISTS (
      SELECT 1 FROM pipelines dp, ${pluginRefsOf(sql`dp.props`)}
       WHERE dp.deleted_at IS NOT NULL AND ${namesPlugin(c.name)} AND ref->'filter'->>'version' = ${c.version}) THEN 'deleted_pipeline_pin'
    WHEN EXISTS (
      SELECT 1 FROM pipeline_templates t, ${pluginRefsOf(sql`t.props`)}
       WHERE ${namesPlugin(c.name)} AND ref->'filter'->>'version' = ${c.version}) THEN 'template_pin'
    ELSE NULL END`;
}

// -----------------------------------------------------------------------------
// Loading one plugin's facts
// -----------------------------------------------------------------------------

/** A transaction `executeRows` accepts. */
type Tx = Parameters<typeof executeRows>[0];

/** Every non-managed system plugin name with at least one live row, sorted. */
export async function systemPluginNames(tx: Tx): Promise<string[]> {
  const rows = await executeRows<{ name: string }>(tx, sql`
    SELECT DISTINCT name FROM plugins
     WHERE lower(org_id) = ${SYSTEM} AND deleted_at IS NULL AND name NOT IN (${managedToolchainNamesSql})
     ORDER BY name`);
  return rows.map((r) => r.name).filter((n) => !isManagedToolchainPlugin(n));
}

/** The Official listing of `name`, or null when the plugin is not listed. */
export async function officialListing(tx: Tx, name: string): Promise<{ id: string; publisherId: string } | null> {
  const rows = await executeRows<{ id: string; publisher_id: string }>(tx, sql`
    SELECT l.id, l.publisher_id FROM plugin_listings l JOIN publishers pub ON pub.id = l.publisher_id
     WHERE pub.handle = ${OFFICIAL} AND l.name = ${name}`);
  return rows[0] ? { id: rows[0].id, publisherId: rows[0].publisher_id } : null;
}

interface FactRow {
  id: string;
  version: string;
  image_digest: string | null;
  yanked_at: Date | string | null;
  deprecated_at: Date | string | null;
  lifecycle: string;
  lv_id: string | null;
  lv_digest: string | null;
  lv_repo: string | null;
  lv_yanked_at: Date | string | null;
  lv_deprecated_at: Date | string | null;
  ret_deprecated_at: Date | string | null;
  held: string | null;
  protection: AutoRemovalProtection | null;
}

const asDate = (v: Date | string | null): Date | null => (v === null ? null : v instanceof Date ? v : new Date(v));

/** The plugin's live system rows, each with its listing copy, its retirement record and its reference hold. */
export async function versionFacts(tx: Tx, name: string, listingId: string | null): Promise<VersionFacts[]> {
  const lid = listingId === null ? sql`NULL::uuid` : sql`${listingId}::uuid`;
  const rows = await executeRows<FactRow>(tx, sql`
    SELECT pr.id, pr.version, pr.image_digest, pr.yanked_at, pr.deprecated_at, pr.lifecycle,
           lv.id AS lv_id, lv.image_digest AS lv_digest, lv.image_repository AS lv_repo,
           lv.yanked_at AS lv_yanked_at, lv.deprecated_at AS lv_deprecated_at,
           r.deprecated_at AS ret_deprecated_at,
           ${retentionHoldSql({
              name: sql`pr.name`,
              version: sql`pr.version`,
              digest: sql`pr.image_digest`,
              publicDigest: sql`lv.image_digest`,
              isDefault: sql`pr.is_default`,
              pausedAt: sql`lv.paused_at`,
            })} AS held,
           ${autoRemovalReasonSql(sql`pr`)} AS protection
      FROM plugins pr
      LEFT JOIN plugin_listing_versions lv ON lv.listing_id = ${lid} AND lv.version = pr.version
      LEFT JOIN plugin_retirements r ON r.plugin_id = pr.id AND r.yanked_at IS NULL
     WHERE lower(pr.org_id) = ${SYSTEM} AND pr.name = ${name} AND pr.deleted_at IS NULL`);
  return rows.map((r) => ({
    pluginId: r.id,
    version: r.version,
    digest: r.image_digest,
    yanked: r.yanked_at !== null || r.lifecycle === 'yanked',
    deprecated: r.deprecated_at !== null,
    retirement: r.ret_deprecated_at !== null ? { deprecatedAt: asDate(r.ret_deprecated_at)! } : null,
    held: r.held,
    protection: r.protection,
    listing: r.lv_id
      ? { id: r.lv_id, digest: r.lv_digest, repository: r.lv_repo, yanked: r.lv_yanked_at !== null, deprecated: r.lv_deprecated_at !== null }
      : null,
  }));
}

/** The listing's explicit, non-denied installs. */
export async function installFacts(tx: Tx, listingId: string | null): Promise<InstallFacts[]> {
  if (listingId === null) return [];
  const rows = await executeRows<{ version_policy: InstallVersionPolicy; pinned_version: string | null; resolved_version: string | null; pending_change: { version?: unknown; versionPolicy?: unknown } | null }>(tx, sql`
    SELECT version_policy, pinned_version, resolved_version, pending_change FROM plugin_installs
     WHERE listing_id = ${listingId}::uuid AND status <> 'denied'`);
  return rows.map((r) => ({
    versionPolicy: r.version_policy,
    pinnedVersion: r.pinned_version,
    resolvedVersion: r.resolved_version,
    pendingChange: r.pending_change && typeof r.pending_change.version === 'string' && typeof r.pending_change.versionPolicy === 'string'
      ? { version: r.pending_change.version, versionPolicy: r.pending_change.versionPolicy as InstallVersionPolicy }
      : null,
  }));
}

/** The listing's versions as the install rules read them. */
export async function listedVersions(tx: Tx, listingId: string | null): Promise<ListedVersionRow[]> {
  if (listingId === null) return [];
  const rows = await executeRows<{ version: string; yanked_at: Date | string | null; paused_at: Date | string | null; breaking: boolean }>(tx, sql`
    SELECT version, yanked_at, paused_at, breaking FROM plugin_listing_versions WHERE listing_id = ${listingId}::uuid`);
  return rows.map((r) => ({ version: r.version, yankedAt: asDate(r.yanked_at), pausedAt: asDate(r.paused_at), breaking: r.breaking === true }));
}

/**
 * How many LIVE pipelines declare the plugin (by name, unqualified or through
 * the Official publisher) but have no resolution row for it — after the refresh,
 * the pipelines whose save-time write never landed.
 */
export async function declaredWithoutResolution(tx: Tx, name: string): Promise<number> {
  const rows = await executeRows<{ n: number | string }>(tx, sql`
    SELECT count(DISTINCT p.id)::int AS n
      FROM pipelines p, ${pluginRefsOf(sql`p.props`)}
     WHERE p.deleted_at IS NULL AND ${namesPlugin(sql`${name}`)}
       AND NOT EXISTS (SELECT 1 FROM pipeline_plugin_resolution r WHERE r.pipeline_id = p.id::text AND r.plugin_name = ${name})`);
  return Number(rows[0]?.n ?? 0);
}
