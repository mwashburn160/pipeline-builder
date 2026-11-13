// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * What plugin versions an org's pipelines are actually on, and which of those are
 * known-vulnerable.
 *
 * Two tables, written here, read by the outdated-plugin and vulnerability report
 * sections:
 *
 *  - `pipeline_plugin_resolution` — the DECLARED side. Recomputed on pipeline
 *    write and on plugin publish, because the alternative is resolving every step
 *    of every pipeline against the catalog on every read, and that is not a query
 *    anyone can afford to put in a report.
 *  - `plugin_vuln_exposure` — the VULNERABLE side, per PIPELINE. A version-level
 *    table would force every reader to re-derive "which of our pipelines is
 *    exposed", which is the only form of the question anybody asks.
 *
 * DECLARED IS NOT DEPLOYED, and the report says which it is showing. A pipeline's
 * config declares `^2.0.0`; what ran at its last deploy is whatever the step
 * manifest recorded, pinned to a digest. Those disagree whenever a pipeline has not
 * re-synthed since a publish — which is most of the time, and exactly the gap a
 * vulnerability report is for. Conflating them would let a report say "fixed"
 * about a pipeline still running the old image.
 *
 * WHO WRITES WHAT:
 *  - the pipeline service, on a pipeline write: `replacePipelineResolution` +
 *    `reconcilePipelineExposures(source 'declared')`;
 *  - the pipeline service, on a deploy registration carrying a step manifest:
 *    `reconcilePipelineExposures(source 'deployed')`;
 *  - the plugin service, when a version becomes the latest (an org plugin's new
 *    default; a listing's publish, yank or unyank): `refreshLatestForPlugin`;
 *  - the nightly rescan, per rescanned version: `syncVersionExposures`, which
 *    fans the version's findings out to every pipeline declaring or running it
 *    (or closes them when the version came back clean).
 */

import { randomUUID } from 'node:crypto';
import { asScanFlag, createLogger, errorMessage, scanFindingKey, type PluginScanFinding, type VulnAcceptance } from '@pipeline-builder/api-core';
import { and, eq, inArray, isNull, lte, sql, type SQL } from 'drizzle-orm';
import { schema } from '../../database/drizzle-schema.js';
import { anyText } from '../../database/pg-result.js';
import type { ExposureSource } from '../../database/schema/reporting-analytics.js';
import { withTenantTx } from '../../database/tenancy.js';

const logger = createLogger('plugin-exposure');

/** How far behind a resolved version is from the newest one available. */
export type VersionGap = 'major' | 'minor' | 'patch' | 'none';

/** One resolved step, as the writer takes it. */
export interface ResolvedStep {
  orgId: string;
  pipelineId: string;
  stageName: string;
  stepName: string;
  pluginPublisher?: string | null;
  pluginName: string;
  declaredVersion?: string | null;
  resolvedVersion?: string | null;
  /** The resolved record: a `plugins` row id or a listing version id. */
  resolvedPluginId?: string | null;
  /** The image digest the resolved version is pinned to (null = image-less). */
  resolvedDigest?: string | null;
  latestVersion?: string | null;
  withinPolicy?: boolean;
  /** The root org of a team's pipeline (see the column). */
  rootOrgId?: string | null;
}

/** `1.2.3` → `[1, 2, 3]`; anything unparseable → null. */
function semver(v: string | null | undefined): [number, number, number] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(v ?? '');
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/**
 * How far `resolved` is behind `latest`.
 *
 * `null` when either side is unparseable, NOT `'none'`. "We could not tell" and
 * "it is up to date" are opposite answers, and reporting the second for the first
 * is how a pipeline on an ancient pre-release version gets a clean bill of health.
 */
export function versionGap(resolved: string | null | undefined, latest: string | null | undefined): VersionGap | null {
  const a = semver(resolved);
  const b = semver(latest);
  if (!a || !b) return null;
  if (b[0] > a[0]) return 'major';
  if (b[0] < a[0]) return 'none'; // resolved is ahead of "latest" — not behind
  if (b[1] > a[1]) return 'minor';
  if (b[1] < a[1]) return 'none';
  if (b[2] > a[2]) return 'patch';
  return 'none';
}

/**
 * Replace a pipeline's resolution rows.
 *
 * DELETE-then-INSERT for the pipeline, in one transaction, because a step can be
 * REMOVED from a config: an upsert-only writer would leave the deleted step's row
 * behind forever, and the outdated-plugin section would keep reporting a step the
 * pipeline no longer has.
 */
export async function replacePipelineResolution(
  pipelineId: string,
  steps: readonly ResolvedStep[],
): Promise<number> {
  const values = steps.map((s) => ({
    orgId: s.orgId,
    pipelineId: s.pipelineId,
    stageName: s.stageName,
    stepName: s.stepName,
    pluginPublisher: s.pluginPublisher ?? null,
    pluginName: s.pluginName,
    declaredVersion: s.declaredVersion ?? null,
    resolvedVersion: s.resolvedVersion ?? null,
    resolvedPluginId: s.resolvedPluginId ?? null,
    resolvedDigest: s.resolvedDigest ?? null,
    latestVersion: s.latestVersion ?? null,
    versionGap: versionGap(s.resolvedVersion, s.latestVersion),
    withinPolicy: s.withinPolicy ?? true,
    rootOrgId: s.rootOrgId ?? null,
    computedAt: new Date(),
  }));

  return withTenantTx(async (tx) => {
    await tx.delete(schema.pipelinePluginResolution)
      .where(eq(schema.pipelinePluginResolution.pipelineId, pipelineId));
    if (values.length === 0) return 0;
    const landed = await tx.insert(schema.pipelinePluginResolution).values(values)
      .returning({ pipelineId: schema.pipelinePluginResolution.pipelineId });
    return (landed as unknown[]).length;
  });
}

/**
 * Refresh the `latest`/gap columns for one plugin across every pipeline that uses
 * it, without re-resolving anything else.
 *
 * Called on publish. A publish changes what "latest" means for every pipeline in
 * the instance that declares the plugin, and re-resolving each of those pipelines
 * from scratch would make publishing cost O(pipelines) work — so only the two
 * columns a publish can change are touched.
 *
 * `owner` says whose plugin it is: a listing (`publisher` handle — every org's
 * pipelines that declare it, so the caller must be elevated), or an org's own
 * plugin (`orgId` — that org's pipelines only: an org plugin's name is unique
 * only within its org, so another org's same-named plugin is a different one).
 */
export async function refreshLatestForPlugin(
  pluginName: string,
  owner: { publisher: string } | { orgId: string },
  latestVersion: string,
): Promise<number> {
  const rows = await withTenantTx((tx) => tx.update(schema.pipelinePluginResolution)
    .set({
      latestVersion,
      // Recomputed in SQL from the row's own resolved version, so one statement
      // covers every pipeline rather than a round trip each.
      // `::text` on every bind of the version: Postgres otherwise deduces
      // inconsistent types for the same parameter (varchar for the assignment,
      // text for `split_part`) and refuses to plan the statement.
      versionGap: sql`CASE
        WHEN ${schema.pipelinePluginResolution.resolvedVersion} IS NULL THEN NULL
        WHEN split_part(${latestVersion}::text, '.', 1)::int > split_part(${schema.pipelinePluginResolution.resolvedVersion}, '.', 1)::int THEN 'major'
        WHEN split_part(${latestVersion}::text, '.', 1)::int < split_part(${schema.pipelinePluginResolution.resolvedVersion}, '.', 1)::int THEN 'none'
        WHEN split_part(${latestVersion}::text, '.', 2)::int > split_part(${schema.pipelinePluginResolution.resolvedVersion}, '.', 2)::int THEN 'minor'
        WHEN split_part(${latestVersion}::text, '.', 2)::int < split_part(${schema.pipelinePluginResolution.resolvedVersion}, '.', 2)::int THEN 'none'
        WHEN split_part(${latestVersion}::text, '.', 3)::int > split_part(${schema.pipelinePluginResolution.resolvedVersion}, '.', 3)::int THEN 'patch'
        ELSE 'none' END`,
      computedAt: new Date(),
    })
    .where(and(
      eq(schema.pipelinePluginResolution.pluginName, pluginName),
      ...('publisher' in owner
        ? [eq(schema.pipelinePluginResolution.pluginPublisher, owner.publisher)]
        : [isNull(schema.pipelinePluginResolution.pluginPublisher), eq(schema.pipelinePluginResolution.orgId, owner.orgId)]),
      // Only rows whose resolved version parses as semver; anything else has no
      // gap to compute and the CASE would throw on the cast.
      sql`${schema.pipelinePluginResolution.resolvedVersion} ~ '^[0-9]+\\.[0-9]+\\.[0-9]+'`,
    ))
    .returning({ pipelineId: schema.pipelinePluginResolution.pipelineId }));
  return (rows as unknown[]).length;
}

/** One flagged version, as the rescan reports it. */
export interface ExposureInput {
  orgId: string;
  pipelineId: string;
  pluginPublisher?: string | null;
  pluginName: string;
  pluginVersion: string;
  imageDigest?: string | null;
  source: ExposureSource;
  criticalCount: number;
  highCount: number;
  topFindings?: Array<Record<string, unknown>>;
  /** Every Critical/High finding key of the version (see the column). */
  findingKeys?: string[];
}

/**
 * Whether an exposure row is LIVE: not fixed, not dismissed as a false positive,
 * and not under an acceptance that is still in force.
 *
 * The ONE predicate every reader uses (the report section, needs-attention, the
 * org's open list). Two readers that disagree about what "exposed" means produce
 * a report whose vulnerability panel and needs-attention list contradict each
 * other — which is how this predicate came to exist. An acceptance LAPSES at its
 * deadline and the row is live again; one with no deadline (which
 * `triageExposure` refuses to write) is treated as in force, as every reader
 * already did.
 *
 * `alias` is the table name or alias the caller's query uses.
 */
export function liveExposurePredicate(now: Date, alias = 'plugin_vuln_exposure'): SQL {
  const col = (c: string) => sql.raw(`${alias}.${c}`);
  return sql`(${col('fixed_at')} IS NULL
    AND (${col('triage_state')} = 'open'
         OR (${col('triage_state')} = 'accepted'
             AND ${col('accepted_until')} IS NOT NULL AND ${col('accepted_until')} <= ${now})))`;
}

/** What a version's scan state contributes to an exposure (see {@link exposureFromScan}). */
export interface ScanState {
  /** The digest the step runs. A scan summary describing another image is ignored. */
  imageDigest?: string | null;
  scanSummary?: unknown;
  scanFlag?: unknown;
  scanFlaggedAt?: Date | string | null;
}

/** The counts an exposure row carries. */
export interface ExposureCounts {
  criticalCount: number;
  highCount: number;
  topFindings: PluginScanFinding[];
  /** Keys of EVERY Critical/High finding itemized (fixable or not), sorted. */
  findingKeys: string[];
}

const keysOf = (findings: readonly PluginScanFinding[]): string[] => [...new Set(findings.map(scanFindingKey))].sort();

/** At most this many findings are stored on an exposure row. */
const EXPOSURE_TOP_FINDINGS = 10;

/**
 * The exposure a version's scan state amounts to, or null when it has none.
 *
 * Reads the rescan's `scan_summary` (fixable Critical AND High, whether or not the
 * gate tripped) and falls back to `scan_flag` for a version flagged before any
 * summary was written. A summary whose digest is not the step's is IGNORED: a
 * version rebuilt on a patched base is a different artifact, and its findings say
 * nothing about the image the pipeline runs. Only FIXABLE findings count — an
 * exposure is something a rebuild or an upgrade can clear.
 */
export function exposureFromScan(state: ScanState): ExposureCounts | null {
  const summary = state.scanSummary && typeof state.scanSummary === 'object' && !Array.isArray(state.scanSummary)
    ? state.scanSummary as Record<string, unknown>
    : null;
  const summaryDigest = typeof summary?.imageDigest === 'string' ? summary.imageDigest : null;
  if (summary && typeof summary.criticalFixable === 'number' && typeof summary.highFixable === 'number'
    && (summaryDigest === null || !state.imageDigest || summaryDigest === state.imageDigest)) {
    if (summary.criticalFixable <= 0 && summary.highFixable <= 0) return null;
    const all = (Array.isArray(summary.findings) ? summary.findings as PluginScanFinding[] : [])
      .filter((f) => f && typeof f.id === 'string');
    const findings = all.filter((f) => Array.isArray(f.fixedIn) && f.fixedIn.length > 0);
    return { criticalCount: summary.criticalFixable, highCount: summary.highFixable, topFindings: findings.slice(0, EXPOSURE_TOP_FINDINGS), findingKeys: keysOf(all) };
  }
  const flag = state.scanFlaggedAt ? asScanFlag(state.scanFlag) : null;
  if (!flag || (flag.gated <= 0 && flag.high <= 0)) return null;
  return { criticalCount: flag.gated, highCount: flag.high, topFindings: flag.findings.slice(0, EXPOSURE_TOP_FINDINGS), findingKeys: keysOf(flag.findings) };
}

/**
 * Open or refresh exposures.
 *
 * Upserts on (pipeline, plugin, version, digest, source) so a nightly rescan REFRESHES the
 * counts rather than opening a new row every night — otherwise the report would
 * show one exposure per night of the same problem, which reads as an escalating
 * situation when nothing changed.
 *
 * A refresh deliberately does NOT reset `triage_state`: an org that accepted a
 * finding with a reason and a deadline has made a decision, and re-raising it every
 * night is how a team learns to ignore the report. It DOES clear a stale
 * acceptance, because that is what the deadline was for.
 */
export async function upsertExposures(inputs: readonly ExposureInput[], now = new Date()): Promise<number> {
  if (inputs.length === 0) return 0;
  const values = inputs.map((e) => ({
    id: randomUUID(),
    orgId: e.orgId,
    pipelineId: e.pipelineId,
    pluginPublisher: e.pluginPublisher ?? null,
    pluginName: e.pluginName,
    pluginVersion: e.pluginVersion,
    imageDigest: e.imageDigest ?? null,
    source: e.source,
    criticalCount: e.criticalCount,
    highCount: e.highCount,
    topFindings: e.topFindings ?? [],
    findingKeys: e.findingKeys ?? [],
    flaggedAt: now,
    updatedAt: now,
  }));

  try {
    const landed = await withTenantTx((tx) => tx.insert(schema.pluginVulnExposure).values(values)
      .onConflictDoUpdate({
        target: [
          schema.pluginVulnExposure.pipelineId,
          schema.pluginVulnExposure.pluginName,
          schema.pluginVulnExposure.pluginVersion,
          schema.pluginVulnExposure.imageDigest,
          schema.pluginVulnExposure.source,
        ],
        set: {
          criticalCount: sql`excluded.critical_count`,
          highCount: sql`excluded.high_count`,
          topFindings: sql`excluded.top_findings`,
          findingKeys: sql`excluded.finding_keys`,
          // Still exposed, so the fix marker is cleared: a row that was closed by a
          // deploy and is flagged again is a regression, and leaving `fixed_at` set
          // would hide it.
          fixedAt: null,
          // An acceptance past its deadline stops being an acceptance. That is the
          // entire point of time-boxing it, and it is enforced HERE rather than at
          // read time so the stored state is the truth.
          // An acceptance covers the findings it was made over, never ones found
          // since: a refresh carrying a finding key the acceptance did not freeze
          // reopens the row, so the decision is made again about what is there now.
          triageState: sql`CASE
            WHEN ${schema.pluginVulnExposure.triageState} = 'accepted'
             AND ${schema.pluginVulnExposure.acceptedUntil} IS NOT NULL
             AND ${schema.pluginVulnExposure.acceptedUntil} <= ${now}
            THEN 'open'
            WHEN ${schema.pluginVulnExposure.triageState} = 'accepted'
             AND NOT (excluded.finding_keys <@ ${schema.pluginVulnExposure.acceptedFindingKeys})
            THEN 'open'
            WHEN ${schema.pluginVulnExposure.triageState} = 'fixed' THEN 'open'
            -- A REMOVED step / pipeline back on the same version: its acceptance
            -- returns if still in force and it covers what the version carries now.
            WHEN ${schema.pluginVulnExposure.triageState} = 'removed'
             AND ${schema.pluginVulnExposure.acceptedUntil} IS NOT NULL
             AND ${schema.pluginVulnExposure.acceptedUntil} > ${now}
             AND excluded.finding_keys <@ ${schema.pluginVulnExposure.acceptedFindingKeys}
            THEN 'accepted'
            WHEN ${schema.pluginVulnExposure.triageState} = 'removed' THEN 'open'
            ELSE ${schema.pluginVulnExposure.triageState} END`,
          updatedAt: now,
        },
      })
      .returning({ id: schema.pluginVulnExposure.id }));
    return (landed as unknown[]).length;
  } catch (err) {
    logger.warn('Plugin exposure upsert failed', { count: values.length, error: errorMessage(err) });
    return 0;
  }
}

/** One version a pipeline still declares / runs WITH open findings. */
export interface LiveVersion {
  pluginName: string;
  pluginVersion: string;
  imageDigest?: string | null;
}

const liveKey = (v: LiveVersion): string => `${v.pluginName}@${v.pluginVersion}@${v.imageDigest ?? ''}`;

/**
 * Close the exposures of one SOURCE a pipeline has moved off — `fixed` when the
 * pipeline still uses the plugin at another version, `removed` when no live step
 * uses the plugin at all (the triage fields stay, so a re-added step gets an
 * unexpired acceptance back — see {@link upsertExposures}).
 *
 * Called when a deploy records a new step manifest (`deployed`) or a pipeline
 * write re-resolves its config (`declared`): anything open for that pipeline and
 * source whose (version, digest) is NOT in `liveVersions` is fixed. Closing by
 * absence rather than waiting for a rescan to notice is what makes "we fixed it"
 * show up in the report on the next deploy instead of the next night.
 *
 * Per source, because the two sides move independently: a config updated to the
 * fixed version closes the DECLARED exposure while the old image keeps running,
 * and its DEPLOYED exposure must stay open until the deploy lands.
 */
export async function closeFixedExposures(
  pipelineId: string,
  source: ExposureSource,
  liveVersions: readonly LiveVersion[],
  now = new Date(),
  opts: { livePlugins?: readonly string[] } = {},
): Promise<number> {
  const live = new Set(liveVersions.map(liveKey));
  const livePlugins = new Set([...liveVersions, ...(opts.livePlugins ?? [])].map((v) => (typeof v === 'string' ? v : v.pluginName)));
  const open = await withTenantTx((tx) => tx.select({
    id: schema.pluginVulnExposure.id,
    pluginName: schema.pluginVulnExposure.pluginName,
    pluginVersion: schema.pluginVulnExposure.pluginVersion,
    imageDigest: schema.pluginVulnExposure.imageDigest,
  }).from(schema.pluginVulnExposure)
    .where(and(
      eq(schema.pluginVulnExposure.pipelineId, pipelineId),
      eq(schema.pluginVulnExposure.source, source),
      isNull(schema.pluginVulnExposure.fixedAt),
    )));
  const staleRows = (open as Array<LiveVersion & { id: string }>).filter((r) => !live.has(liveKey(r)));
  if (staleRows.length === 0) return 0;
  const fixed = staleRows.filter((r) => livePlugins.has(r.pluginName)).map((r) => r.id);
  const removed = staleRows.filter((r) => !livePlugins.has(r.pluginName)).map((r) => r.id);
  let closed = 0;
  for (const [ids, state] of [[fixed, 'fixed'], [removed, 'removed']] as const) {
    if (ids.length === 0) continue;
    const rows = await withTenantTx((tx) => tx.update(schema.pluginVulnExposure)
      .set({ fixedAt: now, triageState: state, updatedAt: now })
      .where(inArray(schema.pluginVulnExposure.id, [...ids]))
      .returning({ id: schema.pluginVulnExposure.id }));
    closed += (rows as unknown[]).length;
  }
  return closed;
}

/**
 * Close every open exposure of a pipeline (or of one source) as `removed` — the
 * pipeline was deleted, or deregistered (its deploy is gone). The triage fields
 * stay: a restore re-records the pipeline's resolution, and
 * {@link upsertExposures} reopens the rows (restoring an acceptance still in
 * force). Returns the rows closed.
 */
export async function closePipelineExposures(
  pipelineId: string,
  state: 'removed',
  opts: { source?: ExposureSource } = {},
  now = new Date(),
): Promise<number> {
  const rows = await withTenantTx((tx) => tx.update(schema.pluginVulnExposure)
    .set({ fixedAt: now, triageState: state, updatedAt: now })
    .where(and(
      eq(schema.pluginVulnExposure.pipelineId, pipelineId),
      isNull(schema.pluginVulnExposure.fixedAt),
      ...(opts.source ? [eq(schema.pluginVulnExposure.source, opts.source)] : []),
    ))
    .returning({ id: schema.pluginVulnExposure.id }));
  return (rows as unknown[]).length;
}

/** One step of a pipeline as {@link reconcilePipelineExposures} takes it. */
export interface ExposureStep {
  pluginPublisher?: string | null;
  pluginName: string;
  pluginVersion: string;
  imageDigest?: string | null;
  /** The resolved version's scan state, as stored on its row. */
  scan: ScanState;
}

/**
 * Bring one pipeline's exposures of one source in line with the steps it now
 * declares (`declared`) or runs (`deployed`): open / refresh a row for every step
 * whose version has open fixable findings, close the rest by absence.
 *
 * Never throws — exposure tracking is reporting, and a pipeline write or a deploy
 * registration must not fail because the report table could not be written.
 */
export async function reconcilePipelineExposures(
  input: { orgId: string; pipelineId: string; source: ExposureSource; steps: readonly ExposureStep[] },
  now = new Date(),
): Promise<{ opened: number; closed: number }> {
  const exposed: ExposureInput[] = [];
  const seen = new Set<string>();
  for (const step of input.steps) {
    const counts = exposureFromScan({ ...step.scan, imageDigest: step.imageDigest ?? step.scan.imageDigest ?? null });
    if (!counts) continue;
    const key = liveKey({ pluginName: step.pluginName, pluginVersion: step.pluginVersion, imageDigest: step.imageDigest });
    if (seen.has(key)) continue; // two steps on one version are one exposure
    seen.add(key);
    exposed.push({
      orgId: input.orgId,
      pipelineId: input.pipelineId,
      pluginPublisher: step.pluginPublisher ?? null,
      pluginName: step.pluginName,
      pluginVersion: step.pluginVersion,
      imageDigest: step.imageDigest ?? null,
      source: input.source,
      ...counts,
      topFindings: counts.topFindings as unknown as Array<Record<string, unknown>>,
    });
  }
  try {
    const opened = await upsertExposures(exposed, now);
    // Every plugin a step still uses (clean versions too): a row for one of
    // them closes `fixed`; a row for a plugin no step uses any more, `removed`.
    const closed = await closeFixedExposures(input.pipelineId, input.source, exposed, now, { livePlugins: input.steps.map((s) => s.pluginName) });
    return { opened, closed };
  } catch (err) {
    logger.warn('Pipeline exposure reconcile failed', { pipelineId: input.pipelineId, source: input.source, error: errorMessage(err) });
    return { opened: 0, closed: 0 };
  }
}

/** A plugin version (optionally one image of it) whose pipelines are wanted. */
export interface PluginVersionRef {
  pluginName: string;
  pluginVersion: string;
  /** Listing publisher handle; null = an org's own plugin row; omitted = either. */
  pluginPublisher?: string | null;
  /** Narrow to pipelines on this image. Omitted = any image of the version. */
  imageDigest?: string | null;
  /** Narrow to these orgs. Omitted = every org the caller's scope can read. */
  orgIds?: readonly string[];
}

/** A pipeline that declares or runs a given plugin version. */
export interface PipelineOnVersion {
  orgId: string;
  pipelineId: string;
  pipelineName: string | null;
  /** `deployed` = its last deploy's step manifest; `declared` = its config resolves to it. */
  source: ExposureSource;
  pluginPublisher: string | null;
  imageDigest: string | null;
  /** The steps on it: `synth` or `<stage>/<step>` (declared) / `<stage>/<action>` (deployed). */
  steps: string[];
}

/**
 * Every LIVE pipeline declaring (`pipeline_plugin_resolution`) or running
 * (`pipeline_step_manifests`) a plugin version, one entry per (pipeline, source)
 * with the steps on it. A soft-deleted pipeline is NOT affected: counting it
 * would put a pipeline nobody can open into a notice or a report. Reads under
 * the CALLER's tenant scope: an org-scoped caller sees its own pipelines, the
 * rescan (elevated) sees every org's.
 */
export async function pipelinesOnVersion(ref: PluginVersionRef): Promise<PipelineOnVersion[]> {
  const publisherSql = (col: string) => (ref.pluginPublisher === undefined
    ? sql``
    : ref.pluginPublisher === null ? sql` AND ${sql.raw(col)} IS NULL` : sql` AND ${sql.raw(col)} = ${ref.pluginPublisher}`);
  const digestSql = (col: string) => (ref.imageDigest ? sql` AND ${sql.raw(col)} = ${ref.imageDigest}` : sql``);
  const orgSql = (col: string) => (ref.orgIds ? sql` AND ${sql.raw(col)} = ${anyText([...ref.orgIds])}` : sql``);
  if (ref.orgIds && ref.orgIds.length === 0) return [];
  const result = await withTenantTx((tx) => tx.execute(sql`
    SELECT x.org_id, x.pipeline_id, x.source, MIN(x.plugin_publisher) AS plugin_publisher, MIN(x.image_digest) AS image_digest,
           p.pipeline_name, array_agg(DISTINCT x.step ORDER BY x.step) AS steps
    FROM (
      SELECT m.org_id, m.pipeline_id::text AS pipeline_id, 'deployed' AS source, m.plugin_publisher, m.image_digest,
             m.stage_name || '/' || m.action_name AS step
      FROM pipeline_step_manifests m
      WHERE m.plugin_name = ${ref.pluginName} AND m.plugin_version = ${ref.pluginVersion}
        ${publisherSql('m.plugin_publisher')}${digestSql('m.image_digest')}${orgSql('m.org_id')}
      UNION ALL
      SELECT r.org_id, r.pipeline_id, 'declared' AS source, r.plugin_publisher, r.resolved_digest AS image_digest,
             CASE WHEN r.stage_name = 'synth' AND r.step_name = 'synth' THEN 'synth' ELSE r.stage_name || '/' || r.step_name END AS step
      FROM pipeline_plugin_resolution r
      WHERE r.plugin_name = ${ref.pluginName} AND r.resolved_version = ${ref.pluginVersion}
        ${publisherSql('r.plugin_publisher')}${digestSql('r.resolved_digest')}${orgSql('r.org_id')}
    ) x
    JOIN pipelines p ON p.id::text = x.pipeline_id AND p.deleted_at IS NULL
    GROUP BY x.org_id, x.pipeline_id, x.source, p.pipeline_name
    ORDER BY x.pipeline_id, x.source
  `));
  const rows = Array.isArray(result) ? result : ((result as { rows?: unknown[] })?.rows ?? []);
  return (rows as Array<Record<string, unknown>>).map((r) => ({
    orgId: String(r.org_id),
    pipelineId: String(r.pipeline_id),
    pipelineName: (r.pipeline_name as string | null) ?? null,
    source: r.source as ExposureSource,
    pluginPublisher: (r.plugin_publisher as string | null) ?? null,
    imageDigest: (r.image_digest as string | null) ?? null,
    steps: Array.isArray(r.steps) ? (r.steps as string[]) : [],
  }));
}

/**
 * The rescan's entry point: one rescanned version's findings, fanned out to every
 * pipeline that declares or runs it.
 *
 * A version with open fixable findings opens / refreshes one exposure per
 * (pipeline, source); a version that came back CLEAN closes every open exposure
 * on it (`fixed`), so a rebuild-in-place or an advisory withdrawn upstream shows
 * as fixed on the next night rather than lingering until each pipeline redeploys.
 *
 * Must run with a scope that can read and write every org's rows (the rescan's
 * elevated context). Never throws.
 */
export async function syncVersionExposures(
  ref: PluginVersionRef,
  scan: ScanState,
  now = new Date(),
): Promise<{ opened: number; closed: number }> {
  try {
    const counts = exposureFromScan({ ...scan, imageDigest: ref.imageDigest ?? scan.imageDigest ?? null });
    if (!counts) return { opened: 0, closed: await closeVersionExposures(ref, now) };
    const pipelines = await pipelinesOnVersion(ref);
    const opened = await upsertExposures(pipelines.map((p) => ({
      orgId: p.orgId,
      pipelineId: p.pipelineId,
      pluginPublisher: p.pluginPublisher,
      pluginName: ref.pluginName,
      pluginVersion: ref.pluginVersion,
      imageDigest: ref.imageDigest ?? p.imageDigest,
      source: p.source,
      criticalCount: counts.criticalCount,
      highCount: counts.highCount,
      topFindings: counts.topFindings as unknown as Array<Record<string, unknown>>,
      findingKeys: counts.findingKeys,
    })), now);
    return { opened, closed: 0 };
  } catch (err) {
    logger.warn('Version exposure sync failed', { plugin: ref.pluginName, version: ref.pluginVersion, error: errorMessage(err) });
    return { opened: 0, closed: 0 };
  }
}

/** Close every open exposure on a version (optionally one image of it). */
export async function closeVersionExposures(ref: PluginVersionRef, now = new Date()): Promise<number> {
  const E = schema.pluginVulnExposure;
  const rows = await withTenantTx((tx) => tx.update(E)
    .set({ fixedAt: now, triageState: 'fixed', updatedAt: now })
    .where(and(
      eq(E.pluginName, ref.pluginName),
      eq(E.pluginVersion, ref.pluginVersion),
      isNull(E.fixedAt),
      ...(ref.imageDigest ? [eq(E.imageDigest, ref.imageDigest)] : []),
      ...(ref.pluginPublisher === undefined ? [] : [ref.pluginPublisher === null ? isNull(E.pluginPublisher) : eq(E.pluginPublisher, ref.pluginPublisher)]),
      ...(ref.orgIds ? [inArray(E.orgId, [...ref.orgIds])] : []),
    ))
    .returning({ id: E.id }));
  return (rows as unknown[]).length;
}

/**
 * The org's live exposures, for the report section.
 *
 * `accepted` rows whose deadline has passed come back as OPEN even if no rescan
 * has refreshed them yet: a read must not present an expired acceptance as a
 * current one, and the report is read far more often than the rescan runs.
 */
export async function openExposures(orgId: string): Promise<Array<{
  pipelineId: string;
  pluginName: string;
  pluginVersion: string;
  pluginPublisher: string | null;
  source: ExposureSource;
  criticalCount: number;
  highCount: number;
  topFindings: Array<Record<string, unknown>>;
  triageState: string;
  flaggedAt: Date;
}>> {
  const now = new Date();
  const rows = await withTenantTx((tx) => tx.select({
    pipelineId: schema.pluginVulnExposure.pipelineId,
    pluginName: schema.pluginVulnExposure.pluginName,
    pluginVersion: schema.pluginVulnExposure.pluginVersion,
    pluginPublisher: schema.pluginVulnExposure.pluginPublisher,
    source: schema.pluginVulnExposure.source,
    criticalCount: schema.pluginVulnExposure.criticalCount,
    highCount: schema.pluginVulnExposure.highCount,
    topFindings: schema.pluginVulnExposure.topFindings,
    triageState: schema.pluginVulnExposure.triageState,
    acceptedUntil: schema.pluginVulnExposure.acceptedUntil,
    flaggedAt: schema.pluginVulnExposure.flaggedAt,
  }).from(schema.pluginVulnExposure)
    .where(and(
      eq(schema.pluginVulnExposure.orgId, orgId),
      liveExposurePredicate(now),
    ))
    .orderBy(sql`${schema.pluginVulnExposure.criticalCount} DESC, ${schema.pluginVulnExposure.highCount} DESC`));

  return (rows as Array<Record<string, unknown>>).map((r) => ({
    pipelineId: r.pipelineId as string,
    pluginName: r.pluginName as string,
    pluginVersion: r.pluginVersion as string,
    pluginPublisher: (r.pluginPublisher as string | null) ?? null,
    source: r.source as ExposureSource,
    criticalCount: r.criticalCount as number,
    highCount: r.highCount as number,
    topFindings: (r.topFindings as Array<Record<string, unknown>>) ?? [],
    // Only acceptances NOT in force pass the live predicate, so an `accepted`
    // row here is an expired one, and reads as what it is: open.
    triageState: r.triageState === 'accepted' ? 'open' : (r.triageState as string),
    flaggedAt: r.flaggedAt as Date,
  }));
}

/** One exposure row as the per-pipeline security views read it. */
export interface PipelineExposure {
  id: string;
  orgId: string;
  pipelineId: string;
  pluginPublisher: string | null;
  pluginName: string;
  pluginVersion: string;
  imageDigest: string | null;
  source: ExposureSource;
  criticalCount: number;
  highCount: number;
  topFindings: Array<Record<string, unknown>>;
  findingKeys: string[];
  /** As stored; an `accepted` row past its deadline reads `open` (see {@link liveExposurePredicate}). */
  triageState: string;
  /** An acceptance still in force right now. */
  acceptanceActive: boolean;
  acceptedUntil: Date | null;
  acceptedFindingKeys: string[];
  acceptedKev: boolean;
  triageReason: string | null;
  triagedBy: string | null;
  triagedAt: Date | null;
  flaggedAt: Date;
  fixedAt: Date | null;
}

const E = () => schema.pluginVulnExposure;

function toPipelineExposure(r: Record<string, unknown>, now: Date): PipelineExposure {
  const until = (r.acceptedUntil as Date | null) ?? null;
  const active = r.triageState === 'accepted' && r.fixedAt == null && until !== null && until.getTime() > now.getTime();
  return {
    id: r.id as string,
    orgId: r.orgId as string,
    pipelineId: r.pipelineId as string,
    pluginPublisher: (r.pluginPublisher as string | null) ?? null,
    pluginName: r.pluginName as string,
    pluginVersion: r.pluginVersion as string,
    imageDigest: (r.imageDigest as string | null) ?? null,
    source: r.source as ExposureSource,
    criticalCount: r.criticalCount as number,
    highCount: r.highCount as number,
    topFindings: (r.topFindings as Array<Record<string, unknown>>) ?? [],
    findingKeys: (r.findingKeys as string[]) ?? [],
    triageState: r.triageState === 'accepted' && !active && r.fixedAt == null ? 'open' : (r.triageState as string),
    acceptanceActive: active,
    acceptedUntil: until,
    acceptedFindingKeys: (r.acceptedFindingKeys as string[]) ?? [],
    acceptedKev: r.acceptedKev === true,
    triageReason: (r.triageReason as string | null) ?? null,
    triagedBy: (r.triagedBy as string | null) ?? null,
    triagedAt: (r.triagedAt as Date | null) ?? null,
    flaggedAt: r.flaggedAt as Date,
    fixedAt: (r.fixedAt as Date | null) ?? null,
  };
}

/**
 * One pipeline's exposures: the unfixed ones (open, accepted, false positive),
 * plus the fixed ones when asked — most severe first. Reads under the CALLER's
 * scope, narrowed to `orgId`.
 */
export async function pipelineExposures(
  orgId: string,
  pipelineId: string,
  opts: { includeFixed?: boolean; now?: Date } = {},
): Promise<PipelineExposure[]> {
  const now = opts.now ?? new Date();
  const rows = await withTenantTx((tx) => tx.select().from(E())
    .where(and(
      eq(E().orgId, orgId),
      eq(E().pipelineId, pipelineId),
      ...(opts.includeFixed ? [] : [isNull(E().fixedAt)]),
    ))
    .orderBy(sql`${E().criticalCount} DESC, ${E().highCount} DESC, ${E().pluginName}`));
  return (rows as Array<Record<string, unknown>>).map((r) => toPipelineExposure(r, now));
}

/** One exposure row of `orgId`, or null. */
export async function exposureById(orgId: string, id: string, now = new Date()): Promise<PipelineExposure | null> {
  const rows = await withTenantTx((tx) => tx.select().from(E()).where(and(eq(E().id, id), eq(E().orgId, orgId))));
  const row = (rows as Array<Record<string, unknown>>)[0];
  return row ? toPipelineExposure(row, now) : null;
}

/** A triage decision. */
export interface TriageDecision {
  state: 'open' | 'accepted' | 'false_positive';
  reason?: string;
  acceptedUntil?: Date;
  /** Accept KEV-listed findings too. Never implied: an acceptance without it does not cover them. */
  kev?: boolean;
  actor: string;
}

/**
 * Record a triage decision on one exposure — and on its SIBLINGS: the same
 * pipeline's other open row for the same version and image (the declared and
 * the deployed side). A risk decision is about what the pipeline runs, and
 * leaving one side open would have the report and the lookup disagree.
 *
 * `accepted` REQUIRES a deadline and a reason. A permanent, unexplained mute is
 * how a finding stops being anybody's problem, and there is no good reason to
 * support it — the caller gets an error rather than a silently unbounded
 * acceptance. The accepted finding keys are FROZEN at the decision: an
 * acceptance covers what was there when it was made, never a finding since.
 *
 * Returns the updated rows (empty when `id` is not `orgId`'s unfixed exposure).
 */
export async function triageExposure(orgId: string, id: string, decision: TriageDecision): Promise<PipelineExposure[]> {
  if (decision.state === 'accepted' && (!decision.acceptedUntil || !decision.reason?.trim())) {
    throw new Error('Accepting a vulnerability exposure needs a reason and an expiry date');
  }
  const now = new Date();
  const target = await exposureById(orgId, id, now);
  if (!target || target.fixedAt) return [];
  const rows = await withTenantTx((tx) => tx.update(E())
    .set({
      triageState: decision.state,
      acceptedUntil: decision.state === 'accepted' ? (decision.acceptedUntil ?? null) : null,
      acceptedFindingKeys: decision.state === 'accepted' ? sql`${E().findingKeys}` : [],
      acceptedKev: decision.state === 'accepted' && decision.kev === true,
      triageReason: decision.reason?.trim() || null,
      triagedBy: decision.actor,
      triagedAt: now,
      updatedAt: now,
    })
    .where(and(
      eq(E().orgId, orgId),
      eq(E().pipelineId, target.pipelineId),
      eq(E().pluginName, target.pluginName),
      eq(E().pluginVersion, target.pluginVersion),
      target.imageDigest === null ? isNull(E().imageDigest) : eq(E().imageDigest, target.imageDigest),
      isNull(E().fixedAt),
    ))
    .returning());
  return (rows as Array<Record<string, unknown>>).map((r) => toPipelineExposure(r, now));
}

/** `name@version@digest` — the key {@link activeAcceptances} answers under. */
export const acceptanceKey = (pluginName: string, pluginVersion: string, imageDigest?: string | null): string =>
  `${pluginName}@${pluginVersion}@${imageDigest ?? ''}`;

/** A pipeline's acceptances in force, keyed by {@link acceptanceKey}, plus the accepted versions per plugin. */
export interface PipelineAcceptances {
  byKey: Map<string, VulnAcceptance & { exposureIds: string[] }>;
  /** `pluginName` → versions with an acceptance (the resolver's `acceptedVersions` hint). */
  versionsByPlugin: Map<string, Set<string>>;
}

/**
 * The acceptances IN FORCE for one pipeline (`accepted`, unfixed, deadline in the
 * future), merged per version and image: the union of the finding keys the rows
 * froze, KEV only when every merged row accepted it. Reads under the caller's
 * scope narrowed to `orgId`; a failed read is "no acceptance" — the stricter answer.
 */
export async function activeAcceptances(orgId: string, pipelineId: string, now = new Date()): Promise<PipelineAcceptances> {
  const out: PipelineAcceptances = { byKey: new Map(), versionsByPlugin: new Map() };
  try {
    const rows = await withTenantTx((tx) => tx.select({
      id: E().id,
      pluginName: E().pluginName,
      pluginVersion: E().pluginVersion,
      imageDigest: E().imageDigest,
      acceptedUntil: E().acceptedUntil,
      acceptedFindingKeys: E().acceptedFindingKeys,
      acceptedKev: E().acceptedKev,
    }).from(E())
      .where(and(
        eq(E().orgId, orgId),
        eq(E().pipelineId, pipelineId),
        eq(E().triageState, 'accepted'),
        isNull(E().fixedAt),
        sql`${E().acceptedUntil} > ${now}`,
      ))) as Array<{ id: string; pluginName: string; pluginVersion: string; imageDigest: string | null; acceptedUntil: Date; acceptedFindingKeys: string[]; acceptedKev: boolean }>;
    for (const r of rows) {
      const key = acceptanceKey(r.pluginName, r.pluginVersion, r.imageDigest);
      const prev = out.byKey.get(key);
      out.byKey.set(key, prev
        ? {
          findingKeys: [...new Set([...prev.findingKeys, ...(r.acceptedFindingKeys ?? [])])],
          kev: prev.kev && r.acceptedKev,
          acceptedUntil: prev.acceptedUntil && new Date(prev.acceptedUntil) < r.acceptedUntil ? prev.acceptedUntil : r.acceptedUntil,
          exposureIds: [...prev.exposureIds, r.id],
        }
        : { findingKeys: r.acceptedFindingKeys ?? [], kev: r.acceptedKev, acceptedUntil: r.acceptedUntil, exposureIds: [r.id] });
      const versions = out.versionsByPlugin.get(r.pluginName) ?? new Set<string>();
      versions.add(r.pluginVersion);
      out.versionsByPlugin.set(r.pluginName, versions);
    }
  } catch (err) {
    logger.warn('Pipeline acceptances unreadable; treating as none', { pipelineId, error: errorMessage(err) });
  }
  return out;
}

/** An acceptance that lapsed, as {@link reopenLapsedAcceptances} returns it. */
export interface LapsedAcceptance {
  id: string;
  orgId: string;
  pipelineId: string;
  pluginPublisher: string | null;
  pluginName: string;
  pluginVersion: string;
  imageDigest: string | null;
  triagedBy: string | null;
  triageReason: string | null;
  acceptedUntil: Date | null;
}

/**
 * Reopen every acceptance whose deadline has passed, and return them so the
 * pipeline owners can be told (N33). Readers already treat such a row as open;
 * writing it makes the stored state the truth and gives the notice exactly one
 * moment to fire. Must run with a scope that can write every org's rows (the
 * nightly rescan's elevated context). Never throws.
 */
export async function reopenLapsedAcceptances(now = new Date()): Promise<LapsedAcceptance[]> {
  try {
    const rows = await withTenantTx((tx) => tx.update(E())
      .set({ triageState: 'open', updatedAt: now })
      .where(and(
        eq(E().triageState, 'accepted'),
        isNull(E().fixedAt),
        lte(E().acceptedUntil, now),
      ))
      .returning({
        id: E().id,
        orgId: E().orgId,
        pipelineId: E().pipelineId,
        pluginPublisher: E().pluginPublisher,
        pluginName: E().pluginName,
        pluginVersion: E().pluginVersion,
        imageDigest: E().imageDigest,
        triagedBy: E().triagedBy,
        triageReason: E().triageReason,
        acceptedUntil: E().acceptedUntil,
      }));
    return rows as LapsedAcceptance[];
  } catch (err) {
    logger.warn('Lapsed acceptances not reopened', { error: errorMessage(err) });
    return [];
  }
}

/**
 * Exposures whose acceptance has lapsed, for the org's security notifications.
 *
 * Surfaced rather than silently reopened: somebody decided to accept this until a
 * date, that date has passed, and the person who decided is the one who should
 * hear about it.
 */
export async function lapsedAcceptances(orgId: string, now = new Date()): Promise<Array<{
  id: string;
  pluginName: string;
  pluginVersion: string;
  triagedBy: string | null;
  acceptedUntil: Date | null;
}>> {
  const rows = await withTenantTx((tx) => tx.select({
    id: schema.pluginVulnExposure.id,
    pluginName: schema.pluginVulnExposure.pluginName,
    pluginVersion: schema.pluginVulnExposure.pluginVersion,
    triagedBy: schema.pluginVulnExposure.triagedBy,
    acceptedUntil: schema.pluginVulnExposure.acceptedUntil,
  }).from(schema.pluginVulnExposure)
    .where(and(
      eq(schema.pluginVulnExposure.orgId, orgId),
      eq(schema.pluginVulnExposure.triageState, 'accepted'),
      isNull(schema.pluginVulnExposure.fixedAt),
      lte(schema.pluginVulnExposure.acceptedUntil, now),
    )));
  return rows as Array<{ id: string; pluginName: string; pluginVersion: string; triagedBy: string | null; acceptedUntil: Date | null }>;
}
