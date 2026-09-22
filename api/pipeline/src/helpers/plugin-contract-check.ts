// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Plugin contract enforcement at pipeline create / update. Each plugin step's resolved plugin declares the metadata / vars keys
 * a pipeline must supply and their types (`requiredMetadata`, `requiredVars`,
 * `metadataTypes`, `varsTypes`); a pipeline that doesn't meet them would fail
 * at synth (or worse, run with a blank value), so it is refused up front with
 * a 400 listing every missing or ill-typed key per step.
 *
 * The checks themselves live in pipeline-core (`checkPluginContract`), shared
 * with the synth-time guard. This module only resolves each step's plugin the
 * way synth does (see docs/plugin-installing.md): the same lookup filter
 * (`pluginLookupFilter`, which carries the reference's `publisher`); without a
 * publisher the caller's own rows (own org, then the parent org's shared rows;
 * exact name, live rows, default, highest semver), then the Official listing
 * through the org's install; with a publisher ONLY that publisher's listing,
 * through an install — the shared resolver in pipeline-data, so the contract
 * checked is the contract synth gets.
 *
 * Existence: a QUALIFIED reference that can't resolve (no such listing, not
 * installed, blocked by the org's policy, yanked) is reported as a step
 * problem — synth would refuse it. So is an unqualified one whose Official
 * listing exists but is refused. An unqualified reference that matches
 * nothing at all is NOT reported (auto-created placeholders, deploy-time
 * resolution).
  */

import { PluginFilterSchema } from '@pipeline-builder/api-core';
import {
  checkPluginContract,
  collectPluginSteps,
  pipelineContractScope,
  pluginLookupFilter,
  type ContractIssue,
  type ContractScopeProps,
} from '@pipeline-builder/pipeline-core';
import {
  buildPluginConditions,
  drizzleListingSource,
  listedPluginRecord,
  pluginResolutionOrderBy,
  resolveListingReference,
  runWithTenantContext,
  schema,
  withTenantTx,
  withViewerContext,
  type ListingDataSource,
  type PluginFilter,
  type ResolutionRefusal,
} from '@pipeline-builder/pipeline-data';
import { and, isNull } from 'drizzle-orm';

/** The contract-relevant columns of the plugin a step resolves to. */
export interface ResolvedContractPlugin {
  id: string;
  /** The owning org of an org row; null for a listed version. */
  orgId: string | null;
  /** The listing's publisher; null for an org row. */
  publisher: string | null;
  name: string;
  version: string;
  requiredMetadata: string[];
  requiredVars: string[];
  metadataTypes: Record<string, 'string' | 'number' | 'bool' | 'json'>;
  varsTypes: Record<string, 'string' | 'number' | 'bool' | 'json'>;
}

/** One step whose plugin contract the pipeline doesn't meet. */
export interface StepContractViolation {
  /** `synth` or `stages[i].steps[j]`. */
  path: string;
  /** `synth` or `<stageName>/<alias ?? name>`. */
  step: string;
  plugin: string;
  version: string;
  /** Keys the pipeline must supply but doesn't, as `metadata.X` / `vars.X`. */
  missing: string[];
  /** Supplied keys whose value doesn't match the declared type. */
  invalid: Array<{ key: string; expected: string; message: string }>;
  /** Why the step's plugin can't resolve at all (not installed, blocked, yanked …). */
  refusal?: { code: ResolutionRefusal['code']; reason: string; message: string };
}

/** What a step's reference resolves to: a plugin, a refusal, or nothing at all. */
export type ContractResolution = { plugin: ResolvedContractPlugin } | { refusal: ResolutionRefusal } | null;

let listingSourceFor: (tx: Parameters<typeof drizzleListingSource>[0]) => ListingDataSource = drizzleListingSource;

/** Test hook: replace the listing data source. */
export function setContractListingSourceForTests(fn: typeof listingSourceFor | null): void {
  listingSourceFor = fn ?? drizzleListingSource;
}

/** The caller's own org row a filter selects (own org, then parent), or null. */
async function resolveOwnRow(filter: Partial<PluginFilter>, orgId: string, parentOrgId?: string): Promise<ResolvedContractPlugin | null> {
  const conditions = [
    ...buildPluginConditions(withViewerContext<PluginFilter>({ ...filter, nameMatch: 'exact' }), orgId, parentOrgId),
    isNull(schema.plugin.deletedAt),
  ];
  const read = () => withTenantTx(async (tx) => tx
    .select({
      id: schema.plugin.id,
      orgId: schema.plugin.orgId,
      name: schema.plugin.name,
      version: schema.plugin.version,
      requiredMetadata: schema.plugin.requiredMetadata,
      requiredVars: schema.plugin.requiredVars,
      metadataTypes: schema.plugin.metadataTypes,
      varsTypes: schema.plugin.varsTypes,
    })
    .from(schema.plugin)
    .where(and(...conditions))
    // The SAME ranking /plugins/lookup resolves with (own org → parent;
    // default; highest semver), so the contract checked is the contract synth
    // will get.
    .orderBy(...pluginResolutionOrderBy(orgId, parentOrgId))
    .limit(1));
  // A parent-org row sits outside the caller's RLS scope; the access-control
  // WHERE above is the gate for it (same as the plugin service's reads).
  const rows = parentOrgId ? await runWithTenantContext({ isSuperAdmin: true }, read) : await read();
  const row = rows[0] as Omit<ResolvedContractPlugin, 'publisher'> | undefined;
  return row ? { ...row, publisher: null } : null;
}

/**
 * Resolve the plugin a lookup filter selects for the caller (see module doc).
 * Exported for tests.
 */
export async function resolveContractPlugin(
  filter: Partial<PluginFilter>,
  orgId: string,
  parentOrgId?: string,
): Promise<ContractResolution> {
  const { publisher, ...rowFilter } = filter;
  if (!publisher) {
    const row = await resolveOwnRow(rowFilter, orgId, parentOrgId);
    if (row) return { plugin: row };
  }
  // Listings resolve by name; an `id` pins an org row, which didn't match.
  if (typeof rowFilter.name !== 'string' || rowFilter.id !== undefined) return null;
  const name = rowFilter.name;
  const scope = { orgId, ...(parentOrgId ? { rootOrgId: parentOrgId } : {}) };
  // The ecosystem tables are app-role only and a team reads its ROOT org's
  // install and policy rows: an elevated read, scoped by the explicit org ids.
  const res = await runWithTenantContext({ isSuperAdmin: true }, () => withTenantTx((tx) =>
    resolveListingReference(listingSourceFor(tx as never), { ...(publisher ? { publisher } : {}), name, ...(rowFilter.version ? { version: rowFilter.version } : {}) }, scope)));
  if (!res) {
    return publisher
      ? { refusal: { code: 'NOT_FOUND', reason: 'no_listing', message: `No listing ${publisher}/${name}.` } }
      : null;
  }
  if (!res.ok) return { refusal: res.refusal };
  const record = listedPluginRecord(res);
  return {
    plugin: {
      id: res.version.id,
      orgId: null,
      publisher: res.publisher.handle,
      name: res.listing.name,
      version: res.version.version,
      requiredMetadata: record.requiredMetadata as string[],
      requiredVars: record.requiredVars as string[],
      metadataTypes: record.metadataTypes as ResolvedContractPlugin['metadataTypes'],
      varsTypes: record.varsTypes as ResolvedContractPlugin['varsTypes'],
    },
  };
}

function toViolation(path: string, step: string, plugin: ResolvedContractPlugin, issues: ContractIssue[]): StepContractViolation {
  return {
    path,
    step,
    plugin: plugin.publisher ? `${plugin.publisher}/${plugin.name}` : plugin.name,
    version: plugin.version,
    missing: issues.filter((i) => i.problem === 'missing').map((i) => `${i.kind}.${i.key}`),
    invalid: issues
      .filter((i) => i.problem === 'type')
      .map((i) => ({ key: `${i.kind}.${i.key}`, expected: i.expected ?? 'string', message: i.message })),
  };
}

/**
 * Every plugin step of `props` whose resolved plugin's contract the pipeline
 * doesn't meet. Each distinct lookup filter is resolved once. An invalid
 * filter (which the plugin lookup would reject) or an unresolvable reference
 * is skipped — not a contract problem.
 */
export async function findPluginContractViolations(
  props: unknown,
  orgId: string,
  parentOrgId?: string,
): Promise<StepContractViolation[]> {
  const steps = collectPluginSteps(props);
  if (steps.length === 0) return [];
  const scope = pipelineContractScope((props ?? {}) as ContractScopeProps);

  const resolved = new Map<string, Promise<ContractResolution>>();
  const resolve = (filter: Record<string, unknown>) => {
    const key = JSON.stringify(Object.entries(filter).sort(([a], [b]) => a.localeCompare(b)));
    let hit = resolved.get(key);
    if (!hit) {
      const parsed = PluginFilterSchema.safeParse(filter);
      hit = parsed.success
        ? resolveContractPlugin(parsed.data as Partial<PluginFilter>, orgId, parentOrgId)
        : Promise.resolve(null);
      resolved.set(key, hit);
    }
    return hit;
  };

  const violations: StepContractViolation[] = [];
  for (const step of steps) {
    const resolution = await resolve(pluginLookupFilter(step));
    if (!resolution) continue;
    if ('refusal' in resolution) {
      const { code, reason, message } = resolution.refusal;
      violations.push({
        path: step.path,
        step: step.label,
        plugin: step.publisher ? `${step.publisher}/${step.name}` : step.name,
        version: typeof step.filter?.version === 'string' ? step.filter.version : '',
        missing: [],
        invalid: [],
        refusal: { code, reason, message },
      });
      continue;
    }
    const issues = checkPluginContract(resolution.plugin, scope);
    if (issues.length > 0) violations.push(toViolation(step.path, step.label, resolution.plugin, issues));
  }
  return violations;
}

/** One-line-per-step summary for the 400 message. */
export function formatContractViolations(violations: StepContractViolation[]): string {
  const lines = violations.map((v) => {
    if (v.refusal) return `  • ${v.step} (${v.plugin}): ${v.refusal.message}`;
    const parts = [
      ...(v.missing.length > 0 ? [`missing ${v.missing.join(', ')}`] : []),
      ...v.invalid.map((i) => `${i.key} must be a ${i.expected}`),
    ];
    return `  • ${v.step} (${v.plugin}@${v.version}): ${parts.join('; ')}`;
  });
  return `Pipeline does not meet the contract of ${violations.length} plugin step${violations.length === 1 ? '' : 's'}:\n${lines.join('\n')}`;
}
