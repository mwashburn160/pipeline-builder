// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Plugin-version remediation for pipelines: which steps run a version with a
 * vulnerability problem, what to move each to, and the props rewrite that does it.
 *
 * A step NEEDS an upgrade when the version it resolves to (exactly as synth
 * resolves it — the contract check's resolver) is rescan-flagged, carries a CISA
 * KEV finding, or has any fixable Critical/High finding.
 *
 * Two suggestions per step, both the NEWEST version that is
 *   - allowed: live (not yanked / paused / deprecated) and admitted by how the org
 *     reaches the plugin (its install's version policy, or the implicit Official
 *     range; for an org's own plugin, any live row it can see), and
 *   - clean: scanned, not flagged, no KEV finding, no fixable Critical/High;
 * `suggestedInPin` additionally satisfies the step's declared pin — the range
 * itself, or for an EXACT pin its caret range (`1.4.2` → `^1.4.2`: same major,
 * which is the compatibility a publisher's semver promises) — and
 * `suggestedLatest` does not.
 *
 * The rewrite only ever touches `plugin.filter.version`:
 *   - an exact pin moves to `suggestedInPin` (or, with `widen`, `suggestedLatest`
 *     when nothing in the pin is clean);
 *   - a range / unversioned reference is left alone — the range already selects
 *     the newest version it admits — unless `widen`, which re-anchors it at
 *     `^<suggestedLatest>`.
 *
 * Managed toolchain steps (pipeline-bootstrap, cdk-synth) are NEVER offered: the
 * toolchain moves as one release, through the platform / org default or the
 * pipeline's `toolchain.release` (docs/plans/bootstrap-image-versioning.md §2, §6).
 */

import { managedToolchainRefName, PluginFilterSchema, scanFreshness, versionScanFacts } from '@pipeline-builder/api-core';
import { collectPluginSteps, pluginLookupFilter, type PluginStepRef } from '@pipeline-builder/pipeline-core';
import {
  buildPluginConditions,
  compareSemver,
  drizzleListingSource,
  implicitInstallRange,
  installAdmits,
  isVersionRange,
  orgListingStates,
  runWithTenantContext,
  satisfiesVersionSpec,
  schema,
  withTenantTx,
  type PluginFilter,
} from '@pipeline-builder/pipeline-data';
import { and, isNull } from 'drizzle-orm';
import { resolveContractPlugin } from './plugin-contract-check.js';

/** Why a step needs an upgrade (what its resolved version's scan says). */
export interface UpgradeReason {
  flagged: boolean;
  kev: number;
  criticalFixable: number;
  highFixable: number;
}

/** One step's remediation. */
export interface StepUpgrade {
  /** `synth` or `<stageName>/<alias ?? name>`. */
  stepKey: string;
  /** `synth` or `stages[i].steps[j]` — where in `props` the step lives. */
  path: string;
  plugin: string;
  publisher: string | null;
  /** The step's `filter.version`, or null when unversioned. */
  declaredVersion: string | null;
  pin: 'exact' | 'range' | 'none';
  currentVersion: string;
  reason: UpgradeReason;
  suggestedInPin: string | null;
  suggestedLatest: string | null;
  /** What `apply` writes to `filter.version` (null = nothing it may write). */
  apply: { version: string | null; widenVersion: string | null };
}

/** The scan columns of one candidate version. */
interface Candidate {
  version: string;
  name: string;
  imageDigest?: string | null;
  buildType?: unknown;
  pluginType?: unknown;
  scannedAt?: Date | string | null;
  scanSummary?: unknown;
  scanFlag?: unknown;
  scanFlaggedAt?: Date | string | null;
}

function reasonOf(c: Pick<Candidate, 'name' | 'version' | 'imageDigest' | 'scanSummary' | 'scanFlag' | 'scanFlaggedAt'>): UpgradeReason {
  const f = versionScanFacts(c);
  return { flagged: f.flagged, kev: f.kev, criticalFixable: f.criticalFixable ?? 0, highFixable: f.highFixable ?? 0 };
}

const needsUpgrade = (r: UpgradeReason): boolean => r.flagged || r.kev > 0 || r.criticalFixable > 0 || r.highFixable > 0;

/** Scanned (or image-less) and nothing to fix. */
function isClean(c: Candidate): boolean {
  if (scanFreshness(c).state === 'unscanned') return false;
  return !needsUpgrade(reasonOf(c));
}

/** The newest clean candidate satisfying `spec` (any when null). */
function newestClean(candidates: readonly Candidate[], spec: string | null): string | null {
  let best: string | null = null;
  for (const c of candidates) {
    if (spec !== null && !satisfiesVersionSpec(c.version, spec)) continue;
    if (!isClean(c)) continue;
    if (best === null || compareSemver(c.version, best) > 0) best = c.version;
  }
  return best;
}

/** The allowed versions of a LISTED plugin, for the org (install policy / implicit range; live only). */
async function listedCandidates(publisher: string, name: string, orgId: string, parentOrgId?: string): Promise<Candidate[]> {
  const scope = { orgId, ...(parentOrgId ? { rootOrgId: parentOrgId } : {}) };
  const states = await runWithTenantContext({ isSuperAdmin: true }, () => withTenantTx((tx) =>
    orgListingStates(drizzleListingSource(tx as never), scope, { names: [name] })));
  const state = states.find((s) => s.publisher.handle === publisher);
  if (!state || state.block || 'code' in state.mode) return [];
  const mode = state.mode;
  const live = state.versions.filter((v) => !v.yankedAt && !v.pausedAt && !v.deprecatedAt);
  const range = mode.kind === 'implicit' ? implicitInstallRange(state.versions) : null;
  return live
    .filter((v) => (mode.kind === 'explicit' ? installAdmits(mode.install, v.version, state.versions) : range !== null && satisfiesVersionSpec(v.version, range)))
    .map((v) => {
      const spec = (v.specSnapshot ?? {}) as Record<string, unknown>;
      return {
        version: v.version,
        name,
        imageDigest: v.imageDigest,
        buildType: spec.buildType,
        pluginType: spec.pluginType,
        scannedAt: v.scannedAt,
        scanSummary: v.scanSummary,
        scanFlag: v.scanFlag,
        scanFlaggedAt: v.scanFlaggedAt,
      };
    });
}

/** The live versions of an org's OWN plugin it can see (own org, parent's shared rows, the system catalog). */
async function ownCandidates(name: string, orgId: string, parentOrgId?: string): Promise<Candidate[]> {
  const read = () => withTenantTx(async (tx) => tx
    .select({
      version: schema.plugin.version,
      name: schema.plugin.name,
      imageDigest: schema.plugin.imageDigest,
      buildType: schema.plugin.buildType,
      pluginType: schema.plugin.pluginType,
      scannedAt: schema.plugin.scannedAt,
      scanSummary: schema.plugin.scanSummary,
      scanFlag: schema.plugin.scanFlag,
      scanFlaggedAt: schema.plugin.scanFlaggedAt,
    })
    .from(schema.plugin)
    .where(and(
      ...buildPluginConditions({ name, nameMatch: 'exact', isActive: true } as Partial<PluginFilter>, orgId, parentOrgId),
      isNull(schema.plugin.deletedAt),
      isNull(schema.plugin.yankedAt),
      isNull(schema.plugin.deprecatedAt),
    )));
  // A parent-org row sits outside the caller's RLS scope; the access-control
  // WHERE above is the gate for it (as in the contract check).
  return (parentOrgId ? await runWithTenantContext({ isSuperAdmin: true }, read) : await read()) as Candidate[];
}

/** What the declared pin means for "satisfying the pin" (an exact pin reads as its caret range). */
function pinSpec(step: PluginStepRef): { pin: StepUpgrade['pin']; declared: string | null; spec: string | null } {
  const declared = typeof step.filter?.version === 'string' && step.filter.version.trim() !== '' ? step.filter.version.trim() : null;
  if (declared === null) return { pin: 'none', declared, spec: null };
  if (isVersionRange(declared)) return { pin: 'range', declared, spec: declared };
  return { pin: 'exact', declared, spec: `^${declared}` };
}

/**
 * Every step of `props` that needs an upgrade, with its suggestions (see the
 * module doc). Steps that resolve to nothing, or to a version with nothing to
 * fix, are not listed.
 */
export async function previewPluginUpgrades(props: unknown, orgId: string, parentOrgId?: string): Promise<StepUpgrade[]> {
  const out: StepUpgrade[] = [];
  const candidatesMemo = new Map<string, Promise<Candidate[]>>();
  for (const step of collectPluginSteps(props)) {
    if (managedToolchainRefName(step)) continue;
    const parsed = PluginFilterSchema.safeParse(pluginLookupFilter(step));
    if (!parsed.success) continue;
    const resolution = await resolveContractPlugin(parsed.data as Partial<PluginFilter>, orgId, parentOrgId);
    if (!resolution || !('plugin' in resolution)) continue;
    const plugin = resolution.plugin;
    const reason = reasonOf({ name: plugin.name, version: plugin.version, ...plugin.scan });
    if (!needsUpgrade(reason)) continue;

    const key = `${plugin.publisher ?? ''}\u0000${plugin.name}`;
    let candidates = candidatesMemo.get(key);
    if (!candidates) {
      candidates = plugin.publisher
        ? listedCandidates(plugin.publisher, plugin.name, orgId, parentOrgId)
        : ownCandidates(plugin.name, orgId, parentOrgId);
      candidatesMemo.set(key, candidates);
    }
    const all = (await candidates).filter((c) => compareSemver(c.version, plugin.version) > 0);
    const { pin, declared, spec } = pinSpec(step);
    const suggestedInPin = newestClean(all, spec);
    const suggestedLatest = newestClean(all, null);
    out.push({
      stepKey: step.label,
      path: step.path,
      plugin: plugin.publisher ? `${plugin.publisher}/${plugin.name}` : plugin.name,
      publisher: plugin.publisher,
      declaredVersion: declared,
      pin,
      currentVersion: plugin.version,
      reason,
      suggestedInPin,
      suggestedLatest,
      apply: {
        version: pin === 'exact' ? suggestedInPin : null,
        widenVersion: pin === 'exact'
          ? (suggestedInPin ?? suggestedLatest)
          : (suggestedLatest ? `^${suggestedLatest}` : null),
      },
    });
  }
  return out;
}

/** One rewritten step, as recorded on the audit event and the response. */
export interface AppliedUpgrade {
  stepKey: string;
  plugin: string;
  publisher: string | null;
  fromVersion: string;
  fromDeclared: string | null;
  toDeclared: string;
}

/**
 * `props` with each upgradable step's `filter.version` rewritten (a deep copy;
 * the input is untouched), and what changed. `onlySteps` narrows to those step
 * keys.
 */
export function applyPluginUpgrades(
  props: unknown,
  upgrades: readonly StepUpgrade[],
  opts: { widen?: boolean; onlySteps?: readonly string[] } = {},
): { props: Record<string, unknown>; applied: AppliedUpgrade[] } {
  const next = JSON.parse(JSON.stringify(props ?? {})) as Record<string, unknown>;
  const applied: AppliedUpgrade[] = [];
  for (const u of upgrades) {
    if (opts.onlySteps && !opts.onlySteps.includes(u.stepKey)) continue;
    const to = opts.widen ? u.apply.widenVersion : u.apply.version;
    if (!to || to === u.declaredVersion) continue;
    const plugin = pluginAt(next, u.path);
    if (!plugin) continue;
    const filter = (plugin.filter && typeof plugin.filter === 'object' ? plugin.filter : {}) as Record<string, unknown>;
    plugin.filter = { ...filter, version: to };
    applied.push({ stepKey: u.stepKey, plugin: u.plugin, publisher: u.publisher, fromVersion: u.currentVersion, fromDeclared: u.declaredVersion, toDeclared: to });
  }
  return { props: next, applied };
}

/** The step's `plugin` object at a `collectPluginSteps` path, or null. */
function pluginAt(props: Record<string, unknown>, path: string): Record<string, unknown> | null {
  const rec = (v: unknown) => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null);
  if (path === 'synth') return rec(rec(props.synth)?.plugin);
  const m = path.match(/^stages\[(\d+)\]\.steps\[(\d+)\]$/);
  if (!m) return null;
  const stages = Array.isArray(props.stages) ? props.stages : [];
  const steps = rec(stages[Number(m[1])])?.steps;
  return rec(rec(Array.isArray(steps) ? steps[Number(m[2])] : null)?.plugin);
}
