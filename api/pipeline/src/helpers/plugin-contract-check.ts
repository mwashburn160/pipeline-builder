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
 *
 * Vulnerabilities: every resolved step is also graded by the SAME assessment
 * `/plugins/lookup` and `/plugins/runtime-check` run (api-core
 * `assessVersionVulns`: flag, KEV, fixable Critical/High against the org's
 * threshold, scan freshness, the org's vulnerability compliance rules, the
 * pipeline's risk acceptances). It NEVER refuses a save — vulnerability state
 * only grades — so it comes back as {@link StepVulnWarnings} next to the
 * contract violations ({@link checkPluginContracts}), for the save response.
  */

import {
  assessVersionVulns, createLogger, errorMessage, maxSeverity, PluginFilterSchema, pluginRunsOwnImage,
  type PluginType, type VulnConsumptionPolicy, type VulnSeverity,
} from '@pipeline-builder/api-core';
import {
  checkPluginContract,
  collectPluginSteps,
  pipelineContractScope,
  pluginLookupFilter,
  type ContractIssue,
  type ContractScopeProps,
} from '@pipeline-builder/pipeline-core';
import {
  acceptanceKey,
  activeAcceptances,
  buildPluginConditions,
  declaredResolution,
  drizzleListingSource,
  effectiveConsumptionPolicy,
  listedPluginRecord,
  pluginResolutionOrderBy,
  reconcilePipelineExposures,
  replacePipelineResolution,
  resolveListingReference,
  runWithTenantContext,
  schema,
  scopeOrgIds,
  withTenantTx,
  withViewerContext,
  type ListingDataSource,
  type PluginFilter,
  type ResolutionRefusal,
  type ScanState,
} from '@pipeline-builder/pipeline-data';
import { and, isNull } from 'drizzle-orm';

const logger = createLogger('plugin-contract-check');

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
  /** The image digest the version is pinned to (null = image-less). */
  imageDigest?: string | null;
  /** The version's stored scan state, for exposure tracking. */
  scan?: ScanState;
  /** What the vulnerability assessment reads besides `scan`. */
  buildType?: string | null;
  pluginType?: string | null;
  scannedAt?: Date | string | null;
  vulnHighFixable?: number | null;
  /** For a flagged listed version: the newest unflagged one the install allows. */
  suggestedVersion?: string | null;
}

/** One step's vulnerability grade at save time — never a refusal. */
export interface StepVulnWarnings {
  /** `synth` or `stages[i].steps[j]`. */
  path: string;
  /** `synth` or `<stageName>/<alias ?? name>`. */
  step: string;
  plugin: string;
  version: string;
  severity: VulnSeverity;
  warnings: Array<{ code: string; severity: VulnSeverity; message: string; suggestedVersion?: string }>;
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
  refusal?: { code: ResolutionRefusal['code'] | 'VALIDATION_ERROR'; reason: string; message: string };
}

/**
 * The managed build image (`pipeline-bootstrap`, pluginType `BuildImage`) is the
 * image the synth and self-mutation RUN ON, never a step of its own
 * (docs/plans/bootstrap-image-versioning.md §1). Refused by name before any
 * lookup (a tenant can't resolve the system row, and the name is reserved) and
 * by the resolved plugin's type.
 */
const BUILD_IMAGE_NAME = 'pipeline-bootstrap';
/** `PluginType.BUILD_IMAGE`. */
const BUILD_IMAGE: PluginType = 'BuildImage';

function buildImageStepViolation(step: { path: string; label: string; name: string; publisher?: string | null }, version: string): StepContractViolation {
  return {
    path: step.path,
    step: step.label,
    plugin: step.publisher ? `${step.publisher}/${step.name}` : step.name,
    version,
    missing: [],
    invalid: [],
    refusal: {
      code: 'VALIDATION_ERROR',
      reason: 'build_image_not_a_step',
      message: `${step.name} is a build image (pluginType BuildImage), not a pipeline step; the toolchain release runs every synth on it.`,
    },
  };
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
      imageDigest: schema.plugin.imageDigest,
      buildType: schema.plugin.buildType,
      pluginType: schema.plugin.pluginType,
      scannedAt: schema.plugin.scannedAt,
      vulnHighFixable: schema.plugin.vulnHighFixable,
      scanSummary: schema.plugin.scanSummary,
      scanFlag: schema.plugin.scanFlag,
      scanFlaggedAt: schema.plugin.scanFlaggedAt,
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
  const row = rows[0] as (Omit<ResolvedContractPlugin, 'publisher' | 'scan'> & { scanSummary: unknown; scanFlag: unknown; scanFlaggedAt: Date | null }) | undefined;
  if (!row) return null;
  const { scanSummary, scanFlag, scanFlaggedAt, ...plugin } = row;
  return { ...plugin, publisher: null, scan: { imageDigest: plugin.imageDigest ?? null, scanSummary, scanFlag, scanFlaggedAt } };
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
      imageDigest: res.version.imageDigest,
      buildType: record.buildType as string,
      pluginType: record.pluginType as string,
      scannedAt: res.version.scannedAt,
      vulnHighFixable: res.version.vulnHighFixable,
      suggestedVersion: res.suggestedVersion,
      scan: {
        imageDigest: res.version.imageDigest,
        scanSummary: res.version.scanSummary,
        scanFlag: res.version.scanFlag,
        scanFlaggedAt: res.version.scanFlaggedAt,
      },
    },
  };
}

/** The org's effective consumption policy (its fixable-High threshold), read elevated like the listing resolution. */
async function vulnPolicyFor(orgId: string, parentOrgId?: string): Promise<VulnConsumptionPolicy> {
  const orgIds = scopeOrgIds({ orgId, ...(parentOrgId ? { rootOrgId: parentOrgId } : {}) });
  const rows = await runWithTenantContext({ isSuperAdmin: true }, () => withTenantTx((tx) => listingSourceFor(tx as never).policiesForOrgs(orgIds)));
  return effectiveConsumptionPolicy(rows, orgIds[0]!, orgIds[1]);
}

/**
 * Grade each resolved step with the shared assessment. Steps without an image
 * of their own say nothing. NEVER throws: a failed read grades nothing rather
 * than failing the save (the lookup grades again at synth).
 */
async function gradeSteps(
  resolved: ReadonlyArray<{ path: string; step: string; plugin: ResolvedContractPlugin }>,
  orgId: string,
  parentOrgId: string | undefined,
  pipelineId: string | undefined,
): Promise<StepVulnWarnings[]> {
  const imaged = resolved.filter((r) => r.plugin.imageDigest && pluginRunsOwnImage({ buildType: r.plugin.buildType ?? undefined, pluginType: r.plugin.pluginType ?? undefined }));
  if (imaged.length === 0) return [];
  try {
    const [policy, acceptances] = await Promise.all([
      vulnPolicyFor(orgId, parentOrgId),
      pipelineId ? activeAcceptances(orgId, pipelineId) : Promise.resolve(null),
    ]);
    const memo = new Map<string, Promise<Awaited<ReturnType<typeof assessVersionVulns>>>>();
    const out: StepVulnWarnings[] = [];
    for (const r of imaged) {
      const p = r.plugin;
      const key = `${p.publisher ?? ''}/${p.name}@${p.version}@${p.imageDigest}`;
      let pending = memo.get(key);
      if (!pending) {
        pending = assessVersionVulns({
          orgId,
          record: {
            name: p.name,
            version: p.version,
            imageDigest: p.imageDigest ?? null,
            buildType: p.buildType ?? undefined,
            pluginType: p.pluginType ?? undefined,
            scannedAt: p.scannedAt ?? null,
            scanSummary: p.scan?.scanSummary,
            scanFlag: p.scan?.scanFlag,
            scanFlaggedAt: p.scan?.scanFlaggedAt ?? null,
            vulnHighFixable: p.vulnHighFixable ?? null,
          },
          policy,
          acceptance: acceptances?.byKey.get(acceptanceKey(p.name, p.version, p.imageDigest ?? null)) ?? null,
          ...(p.suggestedVersion ? { suggestedVersion: p.suggestedVersion } : {}),
        });
        memo.set(key, pending);
      }
      const assessment = await pending;
      if (!assessment.severity) continue;
      out.push({
        path: r.path,
        step: r.step,
        plugin: p.publisher ? `${p.publisher}/${p.name}` : p.name,
        version: p.version,
        severity: assessment.severity,
        warnings: assessment.warnings.map((w) => ({
          code: w.code,
          severity: w.severity,
          message: w.message,
          ...('suggestedVersion' in w && typeof w.suggestedVersion === 'string' ? { suggestedVersion: w.suggestedVersion } : {}),
        })),
      });
    }
    return out;
  } catch (err) {
    logger.warn('Save-time vulnerability grading skipped', { orgId, error: errorMessage(err) });
    return [];
  }
}

/** The loudest severity among step warnings, or null. */
export function loudestSeverity(steps: readonly StepVulnWarnings[]): VulnSeverity | null {
  return steps.reduce<VulnSeverity | null>((acc, s) => (acc ? maxSeverity(acc, s.severity) : s.severity), null);
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
  return (await checkPluginContracts(props, orgId, parentOrgId)).violations;
}

/**
 * The save-time check in full: the contract violations (which refuse the save,
 * 400) and every step's vulnerability grade (which never does — the route puts
 * `vulnerabilities` and its loudest `severity` in the save response). Pass the
 * pipeline's id on an UPDATE so its risk acceptances downgrade what they accepted.
 */
export async function checkPluginContracts(
  props: unknown,
  orgId: string,
  parentOrgId?: string,
  opts: { pipelineId?: string } = {},
): Promise<{ violations: StepContractViolation[]; vulnerabilities: StepVulnWarnings[]; severity: VulnSeverity | null }> {
  const steps = collectPluginSteps(props);
  if (steps.length === 0) return { violations: [], vulnerabilities: [], severity: null };
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
  const resolvedSteps: Array<{ path: string; step: string; plugin: ResolvedContractPlugin }> = [];
  for (const step of steps) {
    const stepVersion = typeof step.filter?.version === 'string' ? step.filter.version : '';
    if (step.name === BUILD_IMAGE_NAME) {
      violations.push(buildImageStepViolation(step, stepVersion));
      continue;
    }
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
    if (resolution.plugin.pluginType === BUILD_IMAGE) {
      violations.push(buildImageStepViolation(step, resolution.plugin.version));
      continue;
    }
    resolvedSteps.push({ path: step.path, step: step.label, plugin: resolution.plugin });
    const issues = checkPluginContract(resolution.plugin, scope);
    if (issues.length > 0) violations.push(toViolation(step.path, step.label, resolution.plugin, issues));
  }
  const vulnerabilities = await gradeSteps(resolvedSteps, orgId, parentOrgId, opts.pipelineId);
  return { violations, vulnerabilities, severity: loudestSeverity(vulnerabilities) };
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

/**
 * Record what every plugin step of a saved pipeline resolves to — the DECLARED
 * side of the vulnerability and outdated-plugin report sections
 * (`pipeline_plugin_resolution`) — and bring the pipeline's DECLARED exposures in
 * line with it.
 *
 * Resolves each step exactly as the contract check (and so synth) does, plus what
 * an UNVERSIONED reference resolves to now, as the "latest" the version gap is
 * measured against. A refused reference is recorded with no resolved version and
 * `withinPolicy: false` rather than dropped: "this step can no longer resolve" is
 * precisely what the outdated section should show.
 *
 * Called after a pipeline write lands, and NEVER throws: this is reporting, and a
 * pipeline save must not fail because the report table could not be written.
 */
export async function recordPipelineResolution(
  pipelineId: string,
  orgId: string,
  parentOrgId: string | undefined,
  props: unknown,
): Promise<void> {
  try {
    // The assembly is shared with the plugin service, which re-resolves the
    // declared side when a publish / yank / delete moves a range (pipeline-data
    // `declaredResolution`); the resolver is this module's, so a save records
    // exactly what the contract check (and so synth) resolves.
    const { rows, exposureSteps } = await declaredResolution({
      pipelineId,
      orgId,
      rootOrgId: parentOrgId ?? null,
      steps: collectPluginSteps(props).map((step) => ({
        label: step.label,
        name: step.name,
        ...(step.publisher ? { publisher: step.publisher } : {}),
        ...(step.filter ? { filter: step.filter as Record<string, unknown> } : {}),
        lookupFilter: pluginLookupFilter(step),
      })),
      resolve: (filter) => {
        const parsed = PluginFilterSchema.safeParse(filter);
        return parsed.success ? resolveContractPlugin(parsed.data as Partial<PluginFilter>, orgId, parentOrgId) : Promise.resolve(null);
      },
    });
    await replacePipelineResolution(pipelineId, rows);
    await reconcilePipelineExposures({ orgId, pipelineId, source: 'declared', steps: exposureSteps });
  } catch (err) {
    logger.warn('Pipeline plugin resolution not recorded', { pipelineId, error: errorMessage(err) });
  }
}
