// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Which pipelines still REFERENCE a plugin version or image — the one rule every
 * removal path asks before it deletes anything: an org plugin delete (forced or
 * not), a bulk delete, a tombstone purge (manual or the retention sweep), the
 * image registry's age GC, the listing image GC.
 *
 * THE RULE: a version (or its image) that any pipeline references cannot be
 * deleted until no pipeline does — whatever its vulnerability state. A
 * vulnerable image is the WORST thing to delete out from under a pipeline: the
 * next run fails to pull, and the owners learn about the CVE from an outage.
 * Vulnerability consequences are graded warnings and notifications, never removal.
 *
 * A reference is any of:
 *  - `declared` — a LIVE pipeline's config resolves to it (`pipeline_plugin_resolution`);
 *  - `deployed` — a pipeline's last deploy recorded it (`pipeline_step_manifests`),
 *    INCLUDING a soft-deleted pipeline: its CodePipeline still runs the image;
 *  - `exposure` — an open DEPLOYED exposure still names it (the same "still runs
 *    it" fact, kept when a manifest is gone).
 *
 * Matched by image digest when the version has one (a team running its parent's
 * plugin, or another org's install, pins the same digest), else by name +
 * version within the owner org and its teams.
 *
 * A MANAGED TOOLCHAIN half (the system org's `pipeline-bootstrap` / `cdk-synth`,
 * docs/plans/bootstrap-image-versioning.md §4/§5) is referenced whenever its
 * RELEASE is: a pipeline deploying or declaring EITHER half of the same version
 * references both. A pipeline that only runs the release's build image (the
 * manifest's non-step `build-image` row) still holds its synth half, and the
 * reverse — the release is one unit, created, deleted and purged together.
 */

import {
  BUILD_IMAGE_STEP_KEY, isManagedToolchainPlugin, isSystemOrgId, MANAGED_TOOLCHAIN_PLUGINS, SYSTEM_ORG_ID,
} from '@pipeline-builder/api-core';
import { sql, type SQL } from 'drizzle-orm';
import { executeRows } from '../database/pg-result.js';
import { withTenantTx } from '../database/tenancy.js';

/** The managed toolchain names as an SQL list (constants, never input). */
const MANAGED_NAMES_SQL = sql.raw(MANAGED_TOOLCHAIN_PLUGINS.map((n) => `'${n}'`).join(', '));
const SYSTEM_ORG_ID_LOWER = SYSTEM_ORG_ID.toLowerCase();

/**
 * "This row is a release half whose RELEASE some pipeline references": a
 * system-org managed row, and a manifest / resolution / open deployed exposure
 * naming either half at its version. Managed names are reserved to the system
 * org, so a publisher-less row with one IS that release's.
 */
function managedReleaseReferenced(cols: { name: SQL; version: SQL; orgId: SQL }): SQL {
  // COALESCE: a caller passing NULL columns (the listing image GC) must read
  // FALSE here, never NULL — `NOT NULL` would silently keep every image.
  return sql`COALESCE(lower(${cols.orgId}) = ${SYSTEM_ORG_ID_LOWER} AND ${cols.name} IN (${MANAGED_NAMES_SQL}) AND (
      EXISTS (SELECT 1 FROM pipeline_step_manifests m WHERE m.plugin_name IN (${MANAGED_NAMES_SQL}) AND m.plugin_version = ${cols.version}
                AND m.plugin_publisher IS NULL)
      OR EXISTS (SELECT 1 FROM pipeline_plugin_resolution r JOIN pipelines lp ON lp.id::text = r.pipeline_id AND lp.deleted_at IS NULL
                  WHERE r.plugin_name IN (${MANAGED_NAMES_SQL}) AND r.resolved_version = ${cols.version} AND r.plugin_publisher IS NULL)
      OR EXISTS (SELECT 1 FROM plugin_vuln_exposure e WHERE e.plugin_name IN (${MANAGED_NAMES_SQL}) AND e.plugin_version = ${cols.version}
                  AND e.plugin_publisher IS NULL AND e.source = 'deployed' AND e.fixed_at IS NULL)), false)`;
}

/** A version / image whose references are wanted. */
export interface VersionReferenceTarget {
  pluginName: string;
  pluginVersion: string;
  imageDigest?: string | null;
  /** The owning org of an org plugin (its teams count too); omitted for a listing version. */
  ownerOrgId?: string | null;
  /** The listing's publisher handle (a listing version); null/omitted for an org plugin. */
  publisher?: string | null;
}

/** Whether `target` is a managed toolchain half (matched release-wide, see the module doc). */
function isManagedReleaseTarget(target: VersionReferenceTarget): boolean {
  return isManagedToolchainPlugin(target.pluginName) && !target.publisher && isSystemOrgId(target.ownerOrgId ?? '');
}

/** One pipeline referencing a version. */
export interface VersionReference {
  pipelineId: string;
  pipelineName: string | null;
  orgId: string;
  source: 'declared' | 'deployed' | 'exposure';
  /** The pipeline is soft-deleted (still deployed: its manifest or exposure remains). */
  pipelineDeleted: boolean;
  steps: string[];
}

/**
 * The SQL predicate "some pipeline references this row's image / version", over
 * a `plugins`-shaped row's columns — the purge guard's form of
 * {@link findVersionReferences} (same three sources, same matching).
 */
export function versionReferencedPredicate(cols: { digest: SQL; name: SQL; version: SQL; orgId: SQL }): SQL {
  return sql`(
    ${managedReleaseReferenced(cols)} OR
    (${cols.digest} IS NOT NULL AND (
      EXISTS (SELECT 1 FROM pipeline_step_manifests m WHERE m.image_digest = ${cols.digest})
      OR EXISTS (SELECT 1 FROM pipeline_plugin_resolution r JOIN pipelines p ON p.id::text = r.pipeline_id AND p.deleted_at IS NULL
                  WHERE r.resolved_digest = ${cols.digest})
      OR EXISTS (SELECT 1 FROM plugin_vuln_exposure e WHERE e.image_digest = ${cols.digest} AND e.source = 'deployed' AND e.fixed_at IS NULL)))
    OR (${cols.digest} IS NULL AND (
      EXISTS (SELECT 1 FROM pipeline_step_manifests m WHERE m.plugin_name = ${cols.name} AND m.plugin_version = ${cols.version}
                AND m.plugin_publisher IS NULL AND lower(m.org_id) = lower(${cols.orgId}))
      OR EXISTS (SELECT 1 FROM pipeline_plugin_resolution r JOIN pipelines p ON p.id::text = r.pipeline_id AND p.deleted_at IS NULL
                  WHERE r.plugin_name = ${cols.name} AND r.resolved_version = ${cols.version} AND r.plugin_publisher IS NULL
                    AND (lower(r.org_id) = lower(${cols.orgId}) OR lower(r.root_org_id) = lower(${cols.orgId})))))
  )`;
}

/**
 * Every pipeline referencing `target` (see the module doc), across orgs — so it
 * must run with a scope that can read every org's rows (elevated). The result
 * names other orgs' pipelines; callers show the OWNER only counts and its own
 * org's pipelines, and notify each referencing org about its own.
 */
export async function findVersionReferences(
  target: VersionReferenceTarget,
  run: <T>(fn: (tx: Parameters<Parameters<typeof withTenantTx>[0]>[0]) => Promise<T>) => Promise<T> = withTenantTx,
): Promise<VersionReference[]> {
  const digest = target.imageDigest ?? null;
  const owner = target.ownerOrgId?.toLowerCase() ?? null;
  const managed = isManagedReleaseTarget(target);
  // A managed half: either half of the release, at its version (module doc).
  const release = (alias: 'r' | 'm' | 'e', versionCol: string) => (managed
    ? sql` OR (${sql.raw(`${alias}.plugin_name`)} IN (${MANAGED_NAMES_SQL}) AND ${sql.raw(`${alias}.${versionCol}`)} = ${target.pluginVersion} AND ${sql.raw(`${alias}.plugin_publisher`)} IS NULL)`
    : sql``);
  const declaredMatch = digest
    ? sql`r.resolved_digest = ${digest}`
    : sql`r.plugin_name = ${target.pluginName} AND r.resolved_version = ${target.pluginVersion}
          AND ${target.publisher ? sql`r.plugin_publisher = ${target.publisher}` : sql`r.plugin_publisher IS NULL AND (lower(r.org_id) = ${owner} OR lower(r.root_org_id) = ${owner})`}`;
  const deployedMatch = digest
    ? sql`m.image_digest = ${digest}`
    : sql`m.plugin_name = ${target.pluginName} AND m.plugin_version = ${target.pluginVersion}
          AND ${target.publisher ? sql`m.plugin_publisher = ${target.publisher}` : sql`m.plugin_publisher IS NULL AND lower(m.org_id) = ${owner}`}`;
  const exposureMatch = digest
    ? sql`e.image_digest = ${digest}`
    : sql`e.plugin_name = ${target.pluginName} AND e.plugin_version = ${target.pluginVersion}
          AND ${target.publisher ? sql`e.plugin_publisher = ${target.publisher}` : sql`e.plugin_publisher IS NULL AND lower(e.org_id) = ${owner}`}`;
  const rows = await run((tx) => executeRows<{ pipeline_id: string; org_id: string; source: VersionReference['source']; pipeline_name: string | null; deleted: boolean; steps: string[] | null }>(tx, sql`
    SELECT x.pipeline_id, x.org_id, x.source, p.pipeline_name, (p.id IS NULL OR p.deleted_at IS NOT NULL) AS deleted,
           array_agg(DISTINCT x.step) FILTER (WHERE x.step IS NOT NULL) AS steps
      FROM (
        SELECT r.pipeline_id, r.org_id, 'declared' AS source,
               CASE WHEN r.stage_name = 'synth' AND r.step_name = 'synth' THEN 'synth' ELSE r.stage_name || '/' || r.step_name END AS step
          FROM pipeline_plugin_resolution r
          JOIN pipelines lp ON lp.id::text = r.pipeline_id AND lp.deleted_at IS NULL
         WHERE (${declaredMatch}${release('r', 'resolved_version')})
        UNION ALL
        SELECT m.pipeline_id::text, m.org_id, 'deployed',
               CASE WHEN m.step_key = ${BUILD_IMAGE_STEP_KEY} THEN ${BUILD_IMAGE_STEP_KEY} ELSE m.stage_name || '/' || m.action_name END
          FROM pipeline_step_manifests m WHERE (${deployedMatch}${release('m', 'plugin_version')})
        UNION ALL
        SELECT e.pipeline_id, e.org_id, 'exposure', NULL
          FROM plugin_vuln_exposure e WHERE (${exposureMatch}${release('e', 'plugin_version')}) AND e.source = 'deployed' AND e.fixed_at IS NULL
      ) x
      LEFT JOIN pipelines p ON p.id::text = x.pipeline_id
     GROUP BY x.pipeline_id, x.org_id, x.source, p.pipeline_name, p.id, p.deleted_at
     ORDER BY x.org_id, x.pipeline_id, x.source
  `));
  return rows.map((r) => ({
    pipelineId: r.pipeline_id,
    pipelineName: r.pipeline_name ?? null,
    orgId: r.org_id,
    source: r.source,
    pipelineDeleted: r.deleted === true,
    steps: r.steps ?? [],
  }));
}

/** Distinct pipelines among `refs` (a pipeline both declared and deployed counts once). */
export function distinctPipelines(refs: readonly VersionReference[]): Array<{ pipelineId: string; pipelineName: string | null; orgId: string; sources: string[]; pipelineDeleted: boolean; steps: string[] }> {
  const byId = new Map<string, { pipelineId: string; pipelineName: string | null; orgId: string; sources: string[]; pipelineDeleted: boolean; steps: string[] }>();
  for (const r of refs) {
    const e = byId.get(r.pipelineId) ?? { pipelineId: r.pipelineId, pipelineName: r.pipelineName, orgId: r.orgId, sources: [], pipelineDeleted: r.pipelineDeleted, steps: [] };
    if (!e.sources.includes(r.source)) e.sources.push(r.source);
    e.steps = [...new Set([...e.steps, ...r.steps])];
    byId.set(r.pipelineId, e);
  }
  return [...byId.values()];
}

/**
 * The image digests an org's namespace still needs: every `plugins` row's
 * digest (active, inactive or soft-deleted — a tombstone is restorable until
 * purged, and the purge itself is guarded) plus every digest a pipeline of the
 * org or its teams declares, runs or has an open deployed exposure on. What the
 * image registry's age GC consults before deleting anything in `org-<id>/*`.
 * Elevated read.
 */
export async function orgImageDigestsInUse(orgId: string): Promise<string[]> {
  const org = orgId.toLowerCase();
  const rows = await withTenantTx((tx) => executeRows<{ d: string }>(tx, sql`
    SELECT DISTINCT d FROM (
      SELECT image_digest AS d FROM plugins WHERE lower(org_id) = ${org} AND image_digest IS NOT NULL
      UNION SELECT r.resolved_digest FROM pipeline_plugin_resolution r
              WHERE r.resolved_digest IS NOT NULL AND (lower(r.org_id) = ${org} OR lower(r.root_org_id) = ${org})
      UNION SELECT m.image_digest FROM pipeline_step_manifests m
              WHERE m.image_digest IS NOT NULL AND m.image_digest IN (SELECT image_digest FROM plugins WHERE lower(org_id) = ${org} AND image_digest IS NOT NULL)
      UNION SELECT m.image_digest FROM pipeline_step_manifests m WHERE m.image_digest IS NOT NULL AND lower(m.org_id) = ${org}
      UNION SELECT e.image_digest FROM plugin_vuln_exposure e
              WHERE e.image_digest IS NOT NULL AND e.source = 'deployed' AND e.fixed_at IS NULL AND lower(e.org_id) = ${org}
    ) x WHERE d IS NOT NULL
  `));
  return rows.map((r) => r.d);
}
