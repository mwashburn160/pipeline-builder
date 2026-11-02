// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Per-STEP plugin resolution state of a pipeline, beyond the version-level
 * reporting tables:
 *
 *  - {@link declaredResolution} — the rows `pipeline_plugin_resolution` and the
 *    declared exposures are written from, given the pipeline's plugin steps and
 *    a resolver. ONE assembly for both writers: the pipeline service on a save
 *    (resolving the way its contract check does) and the plugin service when a
 *    publish, a flag / unflag or a yank changes what a declared range resolves to
 *    (resolving the way `/plugins/lookup` does). The step list comes from the
 *    caller (pipeline-core's `collectPluginSteps`, which this package cannot
 *    import), and the writes stay with the caller, so each can test its own.
 *  - `pipeline_step_lookups` — what synth was TOLD per step at its last lookup
 *    ({@link recordStepLookup}), when synth sends the step's context.
 */

import { and, eq, sql } from 'drizzle-orm';
import type { ExposureStep, ResolvedStep, ScanState } from './reporting/plugin-exposure.js';
import { schema } from '../database/drizzle-schema.js';
import { executeRows } from '../database/pg-result.js';
import { withTenantTx } from '../database/tenancy.js';

/** One plugin step of a pipeline, as pipeline-core's `collectPluginSteps` + `pluginLookupFilter` describe it. */
export interface DeclaredStepInput {
  /** `synth` or `<stageName>/<alias ?? name>`. */
  label: string;
  name: string;
  publisher?: string;
  /** The reference's own `filter` (its `version` is the declared spec). */
  filter?: Record<string, unknown>;
  /** The lookup filter synth would send for it. */
  lookupFilter: Record<string, unknown>;
}

/** What a step's reference resolved to. */
export interface DeclaredStepPlugin {
  id: string;
  /** The listing's publisher; null for an org row. */
  publisher: string | null;
  name: string;
  version: string;
  imageDigest?: string | null;
  scan?: ScanState;
}

/** A resolver's answer: a plugin, a refusal (the reference can't resolve), or nothing at all. */
export type DeclaredStepResolution = { plugin: DeclaredStepPlugin } | { refusal: unknown } | null;

/** `Build/scan` → `['Build', 'scan']`; `synth` → `['synth', 'synth']`. */
export function stageAndStep(label: string): [string, string] {
  const at = label.indexOf('/');
  return at === -1 ? [label, label] : [label.slice(0, at), label.slice(at + 1)];
}

/** The step label a resolution row stands for (the inverse of {@link stageAndStep}). */
export function stepLabelOf(stageName: string, stepName: string): string {
  return stageName === stepName && stageName === 'synth' ? 'synth' : `${stageName}/${stepName}`;
}

/**
 * The declared resolution rows of a pipeline and the steps its DECLARED
 * exposures reconcile against. Each step resolves as synth would, plus what an
 * UNVERSIONED reference resolves to now (the "latest" the version gap is measured
 * against). A refused reference is recorded with no resolved version and
 * `withinPolicy: false` rather than dropped: "this step can no longer resolve"
 * is precisely what the outdated section should show. Each distinct filter is
 * resolved once.
 */
export async function declaredResolution(input: {
  pipelineId: string;
  orgId: string;
  rootOrgId?: string | null;
  steps: readonly DeclaredStepInput[];
  resolve: (filter: Record<string, unknown>) => Promise<DeclaredStepResolution>;
}): Promise<{ rows: ResolvedStep[]; exposureSteps: ExposureStep[] }> {
  const memo = new Map<string, Promise<DeclaredStepResolution>>();
  const resolve = (filter: Record<string, unknown>) => {
    const key = JSON.stringify(Object.entries(filter).sort(([a], [b]) => a.localeCompare(b)));
    let hit = memo.get(key);
    if (!hit) {
      hit = input.resolve(filter);
      memo.set(key, hit);
    }
    return hit;
  };
  const rows = new Map<string, ResolvedStep>();
  const exposureSteps: ExposureStep[] = [];
  for (const step of input.steps) {
    const resolution = await resolve(step.lookupFilter);
    const plugin = resolution && 'plugin' in resolution ? resolution.plugin : null;
    const latest = await resolve({ name: step.name, ...(step.publisher ? { publisher: step.publisher } : {}), isActive: true });
    const latestPlugin = latest && 'plugin' in latest ? latest.plugin : null;
    const [stageName, stepName] = stageAndStep(step.label);
    rows.set(`${stageName}\u0000${stepName}`, {
      orgId: input.orgId,
      pipelineId: input.pipelineId,
      stageName,
      stepName,
      pluginPublisher: plugin?.publisher ?? step.publisher ?? null,
      pluginName: plugin?.name ?? step.name,
      declaredVersion: typeof step.filter?.version === 'string' ? step.filter.version : null,
      resolvedVersion: plugin?.version ?? null,
      resolvedPluginId: plugin?.id ?? null,
      resolvedDigest: plugin?.imageDigest ?? null,
      latestVersion: latestPlugin?.version ?? null,
      withinPolicy: !(resolution && 'refusal' in resolution),
      rootOrgId: input.rootOrgId ?? null,
    });
    if (plugin) {
      exposureSteps.push({
        pluginPublisher: plugin.publisher,
        pluginName: plugin.name,
        pluginVersion: plugin.version,
        imageDigest: plugin.imageDigest ?? null,
        scan: plugin.scan ?? {},
      });
    }
  }
  return { rows: [...rows.values()], exposureSteps };
}

/** A pipeline whose declared steps reference a plugin, with what re-resolving it needs. */
export interface DeclaredPipelineRef {
  pipelineId: string;
  orgId: string;
  rootOrgId: string | null;
  props: unknown;
  /** The step rows as last recorded: `stage\0step` → resolved version + digest. */
  current: Map<string, { resolvedVersion: string | null; resolvedDigest: string | null }>;
}

/**
 * The LIVE pipelines whose declared steps reference a plugin — a listing (every
 * org's pipelines naming that publisher) or an org's own plugin (that org's and
 * its teams' unqualified references) — oldest computation first, at most `limit`.
 * Must run with a scope that can read every org's rows (elevated).
 */
export async function declaredPipelinesForPlugin(
  target: { pluginName: string; publisher: string } | { pluginName: string; orgId: string },
  limit: number,
): Promise<{ pipelines: DeclaredPipelineRef[]; truncated: boolean }> {
  const owner = 'publisher' in target
    ? sql`r.plugin_publisher = ${target.publisher}`
    : sql`r.plugin_publisher IS NULL AND (lower(r.org_id) = ${target.orgId.toLowerCase()} OR lower(r.root_org_id) = ${target.orgId.toLowerCase()})`;
  return withTenantTx(async (tx) => {
    const ids = await executeRows<{ pipeline_id: string }>(tx, sql`
      SELECT r.pipeline_id, MIN(r.computed_at) AS oldest
        FROM pipeline_plugin_resolution r
        JOIN pipelines p ON p.id::text = r.pipeline_id AND p.deleted_at IS NULL
       WHERE r.plugin_name = ${target.pluginName} AND ${owner}
       GROUP BY r.pipeline_id
       ORDER BY oldest
       LIMIT ${limit + 1}
    `);
    const truncated = ids.length > limit;
    const wanted = ids.slice(0, limit).map((r) => r.pipeline_id);
    if (wanted.length === 0) return { pipelines: [], truncated: false };
    const pipelines = await executeRows<{ id: string; org_id: string; props: unknown }>(tx, sql`
      SELECT p.id::text AS id, p.org_id, p.props FROM pipelines p WHERE p.id::text = ANY(${wanted}) AND p.deleted_at IS NULL
    `);
    const steps = await executeRows<{ pipeline_id: string; stage_name: string; step_name: string; resolved_version: string | null; resolved_digest: string | null; root_org_id: string | null }>(tx, sql`
      SELECT pipeline_id, stage_name, step_name, resolved_version, resolved_digest, root_org_id
        FROM pipeline_plugin_resolution WHERE pipeline_id = ANY(${wanted})
    `);
    return {
      truncated,
      pipelines: pipelines.map((p) => {
        const own = steps.filter((s) => s.pipeline_id === p.id);
        return {
          pipelineId: p.id,
          orgId: p.org_id,
          rootOrgId: own.find((s) => s.root_org_id)?.root_org_id ?? null,
          props: p.props,
          current: new Map(own.map((s) => [`${s.stage_name}\u0000${s.step_name}`, { resolvedVersion: s.resolved_version, resolvedDigest: s.resolved_digest }])),
        };
      }),
    };
  });
}

/** One step's lookup outcome, as `/plugins/lookup` records it. */
export interface StepLookupRecord {
  orgId: string;
  pipelineId: string;
  stepKey: string;
  pluginPublisher?: string | null;
  pluginName: string;
  requestedVersion?: string | null;
  resolvedVersion?: string | null;
  resolvedPluginId?: string | null;
  imageDigest?: string | null;
  warnings: Array<{ code: string; message: string; severity?: string }>;
  refusal?: { code: string; reason: string; message: string } | null;
  lookedUpAt?: Date;
}

const L = () => schema.pipelineStepLookup;

/**
 * Record (replace) one step's last lookup outcome. Runs under the CALLER's
 * scope, which RLS pins to its own org: a context naming another org's pipeline
 * is refused by the caller before it gets here.
 */
export async function recordStepLookup(r: StepLookupRecord): Promise<void> {
  const values = {
    orgId: r.orgId,
    pipelineId: r.pipelineId,
    stepKey: r.stepKey,
    pluginPublisher: r.pluginPublisher ?? null,
    pluginName: r.pluginName,
    requestedVersion: r.requestedVersion ?? null,
    resolvedVersion: r.resolvedVersion ?? null,
    resolvedPluginId: r.resolvedPluginId ?? null,
    imageDigest: r.imageDigest ?? null,
    warnings: r.warnings.slice(0, 50).map((w) => ({ code: w.code, message: w.message.slice(0, 2000), ...(w.severity ? { severity: w.severity } : {}) })),
    refusal: r.refusal ?? null,
    lookedUpAt: r.lookedUpAt ?? new Date(),
  };
  const { pipelineId: _p, stepKey: _s, ...update } = values;
  await withTenantTx((tx) => tx.insert(L()).values(values)
    .onConflictDoUpdate({ target: [L().pipelineId, L().stepKey], set: update }));
}

/** A pipeline's recorded step lookups (its org only). */
export async function pipelineStepLookups(orgId: string, pipelineId: string): Promise<Array<typeof schema.pipelineStepLookup.$inferSelect>> {
  return withTenantTx((tx) => tx.select().from(L())
    .where(and(eq(L().orgId, orgId), eq(L().pipelineId, pipelineId)))
    .orderBy(L().stepKey)) as Promise<Array<typeof schema.pipelineStepLookup.$inferSelect>>;
}
