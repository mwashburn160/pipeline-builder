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
 */

import { createLogger, errorMessage } from '@pipeline-builder/api-core';
import { randomUUID } from 'node:crypto';
import { and, eq, inArray, isNull, lte, sql } from 'drizzle-orm';
import { schema } from '../../database/drizzle-schema.js';
import { withTenantTx } from '../../database/tenancy.js';
import type { ExposureSource } from '../../database/schema/reporting-analytics.js';

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
  latestVersion?: string | null;
  withinPolicy?: boolean;
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
    latestVersion: s.latestVersion ?? null,
    versionGap: versionGap(s.resolvedVersion, s.latestVersion),
    withinPolicy: s.withinPolicy ?? true,
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
 */
export async function refreshLatestForPlugin(
  pluginName: string,
  pluginPublisher: string | null,
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
      pluginPublisher === null
        ? isNull(schema.pipelinePluginResolution.pluginPublisher)
        : eq(schema.pipelinePluginResolution.pluginPublisher, pluginPublisher),
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
}

/**
 * Open or refresh exposures.
 *
 * Upserts on (pipeline, plugin, version, source) so a nightly rescan REFRESHES the
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
          schema.pluginVulnExposure.source,
        ],
        set: {
          criticalCount: sql`excluded.critical_count`,
          highCount: sql`excluded.high_count`,
          topFindings: sql`excluded.top_findings`,
          imageDigest: sql`COALESCE(excluded.image_digest, ${schema.pluginVulnExposure.imageDigest})`,
          // Still exposed, so the fix marker is cleared: a row that was closed by a
          // deploy and is flagged again is a regression, and leaving `fixed_at` set
          // would hide it.
          fixedAt: null,
          // An acceptance past its deadline stops being an acceptance. That is the
          // entire point of time-boxing it, and it is enforced HERE rather than at
          // read time so the stored state is the truth.
          triageState: sql`CASE
            WHEN ${schema.pluginVulnExposure.triageState} = 'accepted'
             AND ${schema.pluginVulnExposure.acceptedUntil} IS NOT NULL
             AND ${schema.pluginVulnExposure.acceptedUntil} <= ${now}
            THEN 'open'
            WHEN ${schema.pluginVulnExposure.triageState} = 'fixed' THEN 'open'
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

/**
 * Close the exposures a pipeline has moved off.
 *
 * Called when a deploy records a new step manifest: anything flagged for that
 * pipeline whose version is NOT in the set it now runs is fixed. Closing by
 * absence rather than waiting for a rescan to notice is what makes "we fixed it"
 * show up in the report on the next deploy instead of the next night.
 */
export async function closeFixedExposures(
  pipelineId: string,
  liveVersions: ReadonlyArray<{ pluginName: string; pluginVersion: string }>,
  now = new Date(),
): Promise<number> {
  const live = new Set(liveVersions.map((v) => `${v.pluginName}@${v.pluginVersion}`));
  const open = await withTenantTx((tx) => tx.select({
    id: schema.pluginVulnExposure.id,
    pluginName: schema.pluginVulnExposure.pluginName,
    pluginVersion: schema.pluginVulnExposure.pluginVersion,
  }).from(schema.pluginVulnExposure)
    .where(and(
      eq(schema.pluginVulnExposure.pipelineId, pipelineId),
      isNull(schema.pluginVulnExposure.fixedAt),
    )));
  const stale = (open as Array<{ id: string; pluginName: string; pluginVersion: string }>)
    .filter((r) => !live.has(`${r.pluginName}@${r.pluginVersion}`))
    .map((r) => r.id);
  if (stale.length === 0) return 0;

  const closed = await withTenantTx((tx) => tx.update(schema.pluginVulnExposure)
    .set({ fixedAt: now, triageState: 'fixed', updatedAt: now })
    .where(inArray(schema.pluginVulnExposure.id, stale))
    .returning({ id: schema.pluginVulnExposure.id }));
  return (closed as unknown[]).length;
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
      isNull(schema.pluginVulnExposure.fixedAt),
      // An acceptance that has run out is not an acceptance.
      sql`(${schema.pluginVulnExposure.triageState} <> 'accepted'
           OR ${schema.pluginVulnExposure.acceptedUntil} IS NULL
           OR ${schema.pluginVulnExposure.acceptedUntil} <= ${now})`,
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
    // An expired acceptance reads as open, which is what it is.
    triageState: r.triageState === 'accepted' && r.acceptedUntil ? 'open' : (r.triageState as string),
    flaggedAt: r.flaggedAt as Date,
  }));
}

/**
 * Record a triage decision.
 *
 * `accepted` REQUIRES a deadline and a reason. A permanent, unexplained mute is
 * how a finding stops being anybody's problem, and there is no good reason to
 * support it — the caller gets an error rather than a silently unbounded
 * acceptance.
 */
export async function triageExposure(
  orgId: string,
  id: string,
  decision: { state: 'open' | 'accepted' | 'false_positive'; reason?: string; acceptedUntil?: Date; actor: string },
): Promise<boolean> {
  if (decision.state === 'accepted' && (!decision.acceptedUntil || !decision.reason?.trim())) {
    throw new Error('Accepting a vulnerability exposure needs a reason and an expiry date');
  }
  const rows = await withTenantTx((tx) => tx.update(schema.pluginVulnExposure)
    .set({
      triageState: decision.state,
      acceptedUntil: decision.state === 'accepted' ? (decision.acceptedUntil ?? null) : null,
      triageReason: decision.reason ?? null,
      triagedBy: decision.actor,
      triagedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(and(
      eq(schema.pluginVulnExposure.id, id),
      eq(schema.pluginVulnExposure.orgId, orgId),
    ))
    .returning({ id: schema.pluginVulnExposure.id }));
  return (rows as unknown[]).length > 0;
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
