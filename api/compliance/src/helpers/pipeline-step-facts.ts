// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Step facts for a PIPELINE entity — what its plugin steps ARE, which no field
 * of the stored row says.
 *
 * A pipeline's `props` names each step's plugin by reference (name, publisher,
 * version filter); whether that step is a security scanner, a manual approval
 * gate, or runs a version with known-exploited findings is a property of the
 * plugin it RESOLVES to. The rule engine reads flat fields, so the security
 * rule templates read these derived ones under `stepFacts.*`:
 *
 *   - `securityScanSteps` — steps whose plugin's catalog `category` is
 *     `security` (the canonical category every scanner plugin declares —
 *     trivy, grype, snyk, semgrep, gitleaks …), so a new scanner counts without
 *     anyone editing a name list.
 *   - `productionStages` / `approvalBeforeProduction` — a stage whose
 *     `environment` reads as production (`prod`, `production`, `prd`, `live`)
 *     must be preceded by a `ManualApprovalStep`: in an earlier stage, or in the
 *     same stage as a `pre` step (the default position). No production stage →
 *     vacuously true.
 *   - `kevSteps` / `kevStepNames` — steps whose resolved version's latest scan
 *     carries a CISA known-exploited (KEV) Critical/High finding.
 *
 * Resolution mirrors the pipeline service's contract check (and so synth):
 * own/parent org rows first for an unqualified reference, else the listing
 * through the org's install and policy. A step that resolves to nothing
 * contributes nothing. A KEV count is digest-agnostic on purpose: a summary from
 * a previous build of the SAME version still says the version shipped it.
 *
 * Computed ONLY when an active rule reads a `stepFacts.*` field (see
 * {@link rulesReadStepFacts}) — it costs a resolution per distinct reference.
 * If resolution fails, the fields are DEFERRED (the rules reading them are
 * skipped and reported as such), never guessed.
 */

import { createLogger, errorMessage, PluginFilterSchema, type PluginScanSummary } from '@pipeline-builder/api-core';
import { collectPluginSteps, pluginLookupFilter } from '@pipeline-builder/pipeline-core';
import {
  buildPluginConditions,
  drizzleListingSource,
  listedPluginRecord,
  pluginResolutionOrderBy,
  resolveListingReference,
  runWithTenantContext,
  schema,
  withTenantTx,
  type PluginFilter,
} from '@pipeline-builder/pipeline-data';
import { and, isNull } from 'drizzle-orm';

const logger = createLogger('pipeline-step-facts');

/** The attribute key the facts are stored under. */
export const STEP_FACTS_KEY = 'stepFacts';

/** The derived fields, as rule paths (`stepFacts.<field>`). */
export const STEP_FACT_FIELDS = [
  'securityScanSteps', 'productionStages', 'approvalBeforeProduction', 'kevSteps', 'kevStepNames',
] as const;

/** What a step's reference resolves to, as far as the step facts care. */
export interface StepPluginFacts {
  category: string | null;
  pluginType: string | null;
  /** KEV-listed Critical/High findings in the version's latest scan. */
  kev: number;
}

export interface PipelineStepFacts {
  securityScanSteps: number;
  productionStages: number;
  approvalBeforeProduction: boolean;
  kevSteps: number;
  kevStepNames: string[];
}

/** Stage environments that read as production. */
const PRODUCTION_ENV = /^(prod|production|prd|live)$/i;

/**
 * The VULNERABILITY step facts. Vulnerability state never blocks a pipeline
 * from saving, synthesizing, deploying or running — it produces findings and
 * notifications only (a platform decision).
 * So a rule reading one of these is ENFORCED as a warning whatever severity it
 * was authored with ({@link asNonBlockingVulnRules}); the other step facts
 * (scanner present, approval before production) are not vulnerability state
 * and keep their block/warn behaviour.
 */
const VULN_STEP_FACTS = new Set(['kevSteps', 'kevStepNames']);

/** Whether a rule field reads a vulnerability step fact (`stepFacts.kevSteps`, `$count(stepFacts.kevStepNames)` …). */
function readsVulnFact(field: unknown): boolean {
  if (typeof field !== 'string') return false;
  const m = field.match(new RegExp(`(?:^|\\()${STEP_FACTS_KEY}\\.(\\w+)`));
  return !!m && VULN_STEP_FACTS.has(m[1]!);
}

/**
 * `rules` with every rule that reads a vulnerability step fact downgraded to
 * `warning` (see {@link VULN_STEP_FACTS}), so the engine reports it and never
 * blocks on it. Other rules are returned as they are.
 */
export function asNonBlockingVulnRules<R extends { field?: string | null; conditions?: unknown; severity: string }>(rules: readonly R[]): R[] {
  return rules.map((r) => {
    const conditions = Array.isArray(r.conditions) ? r.conditions as Array<{ field?: unknown }> : [];
    const vuln = readsVulnFact(r.field) || conditions.some((c) => c && readsVulnFact(c.field));
    return vuln && r.severity !== 'warning' ? { ...r, severity: 'warning' } as R : r;
  });
}

/** Whether any of `rules` (or their conditions) reads a `stepFacts.*` field. */
export function rulesReadStepFacts(rules: ReadonlyArray<{ field?: string | null; conditions?: unknown }>): boolean {
  const reads = (f: unknown) => typeof f === 'string' && (f.startsWith(`${STEP_FACTS_KEY}.`) || f.includes(`(${STEP_FACTS_KEY}.`));
  return rules.some((r) => reads(r.field)
    || (Array.isArray(r.conditions) && r.conditions.some((c) => c && typeof c === 'object' && reads((c as { field?: unknown }).field))));
}

/** KEV count from a stored scan summary, else the flag (a version flagged before summaries existed). */
function kevCount(scanSummary: unknown, scanFlag: unknown): number {
  const summary = scanSummary && typeof scanSummary === 'object' ? scanSummary as Partial<PluginScanSummary> : null;
  if (summary && typeof summary.kev === 'number') return summary.kev;
  const flag = scanFlag && typeof scanFlag === 'object' ? scanFlag as { kev?: unknown } : null;
  return typeof flag?.kev === 'number' ? flag.kev : 0;
}

/**
 * The derivation itself, pure: `props` plus what each step resolved to (keyed
 * by the step's `path`, see `collectPluginSteps`).
 */
export function derivePipelineStepFacts(props: unknown, resolved: ReadonlyMap<string, StepPluginFacts>): PipelineStepFacts {
  const steps = collectPluginSteps(props);
  let securityScanSteps = 0;
  const kevStepNames: string[] = [];
  for (const step of steps) {
    const facts = resolved.get(step.path);
    if (!facts) continue;
    if (facts.category === 'security') securityScanSteps++;
    if (facts.kev > 0) kevStepNames.push(step.label);
  }

  const stages = Array.isArray((props as { stages?: unknown } | null)?.stages) ? (props as { stages: unknown[] }).stages : [];
  let productionStages = 0;
  let approvalSeen = false;
  let approvalBeforeProduction = true;
  stages.forEach((stage, i) => {
    const s = (stage && typeof stage === 'object' ? stage : {}) as { environment?: unknown; steps?: unknown };
    const stageSteps = Array.isArray(s.steps) ? s.steps : [];
    const isApproval = (j: number) => resolved.get(`stages[${i}].steps[${j}]`)?.pluginType === 'ManualApprovalStep';
    if (typeof s.environment === 'string' && PRODUCTION_ENV.test(s.environment)) {
      productionStages++;
      const gatedHere = stageSteps.some((step, j) => isApproval(j)
        && (step as { position?: unknown } | null)?.position !== 'post');
      if (!approvalSeen && !gatedHere) approvalBeforeProduction = false;
    }
    if (stageSteps.some((_, j) => isApproval(j))) approvalSeen = true;
  });

  return { securityScanSteps, productionStages, approvalBeforeProduction, kevSteps: kevStepNames.length, kevStepNames };
}

/** Resolve one lookup filter the way the pipeline service's contract check does. */
async function resolveStepPlugin(filter: Partial<PluginFilter>, orgId: string, parentOrgId?: string): Promise<StepPluginFacts | null> {
  const { publisher, ...rowFilter } = filter;
  if (!publisher) {
    const rows = await withTenantTx(async (tx) => tx
      .select({
        category: schema.plugin.category,
        pluginType: schema.plugin.pluginType,
        scanSummary: schema.plugin.scanSummary,
        scanFlag: schema.plugin.scanFlag,
      })
      .from(schema.plugin)
      .where(and(...buildPluginConditions({ ...rowFilter, nameMatch: 'exact' } as Partial<PluginFilter>, orgId, parentOrgId), isNull(schema.plugin.deletedAt)))
      .orderBy(...pluginResolutionOrderBy(orgId, parentOrgId))
      .limit(1));
    const row = rows[0] as { category: string | null; pluginType: string | null; scanSummary: unknown; scanFlag: unknown } | undefined;
    if (row) return { category: row.category, pluginType: row.pluginType, kev: kevCount(row.scanSummary, row.scanFlag) };
  }
  if (typeof rowFilter.name !== 'string' || rowFilter.id !== undefined) return null;
  const scope = { orgId, ...(parentOrgId ? { rootOrgId: parentOrgId } : {}) };
  const res = await withTenantTx((tx) => resolveListingReference(drizzleListingSource(tx as never), {
    ...(publisher ? { publisher } : {}), name: rowFilter.name as string, ...(rowFilter.version ? { version: rowFilter.version } : {}),
  }, scope));
  if (!res || !res.ok) return null;
  const record = listedPluginRecord(res);
  return {
    category: typeof record.category === 'string' ? record.category : null,
    pluginType: typeof record.pluginType === 'string' ? record.pluginType : null,
    kev: kevCount(res.version.scanSummary, res.version.scanFlag),
  };
}

/**
 * `attributes` plus `stepFacts`, resolved for `orgId`. On a resolution failure
 * the facts are deferred instead (see the module doc).
 */
export async function withPipelineStepFacts(
  attributes: Record<string, unknown>,
  orgId: string,
  parentOrgId?: string,
): Promise<{ attributes: Record<string, unknown>; deferredFields: string[] }> {
  try {
    // Elevated read, scoped by the explicit org ids — the scan executor already
    // runs elevated, and a team reads its root org's install/policy rows.
    const resolved = await runWithTenantContext({ isSuperAdmin: true }, async () => {
      const memo = new Map<string, Promise<StepPluginFacts | null>>();
      const out = new Map<string, StepPluginFacts>();
      for (const step of collectPluginSteps(attributes.props)) {
        const filter = pluginLookupFilter(step);
        const key = JSON.stringify(Object.entries(filter).sort(([a], [b]) => a.localeCompare(b)));
        let hit = memo.get(key);
        if (!hit) {
          const parsed = PluginFilterSchema.safeParse(filter);
          hit = parsed.success ? resolveStepPlugin(parsed.data as Partial<PluginFilter>, orgId, parentOrgId) : Promise.resolve(null);
          memo.set(key, hit);
        }
        const facts = await hit;
        if (facts) out.set(step.path, facts);
      }
      return out;
    });
    return { attributes: { ...attributes, [STEP_FACTS_KEY]: derivePipelineStepFacts(attributes.props, resolved) }, deferredFields: [] };
  } catch (err) {
    logger.warn('Pipeline step facts unavailable; rules reading them are deferred', { orgId, error: errorMessage(err) });
    // The engine defers by ROOT attribute, so `stepFacts` defers every `stepFacts.*` rule.
    return { attributes, deferredFields: [STEP_FACTS_KEY] };
  }
}
