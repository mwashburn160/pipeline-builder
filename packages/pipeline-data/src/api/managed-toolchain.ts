// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * THE resolver for the managed toolchain (docs/plans/bootstrap-image-versioning.md
 * §2). `pipeline-bootstrap@V` and `cdk-synth@V` are two SYSTEM-ORG plugin rows
 * that share one release version `V`; every path that can resolve a managed
 * name answers from here and nothing else may:
 *
 *   release pin given → that release, if it EXISTS (yanked / deprecated /
 *                       never-promoted still resolve, with a warning; deleted ⇒ 404)
 *   else org default  → the NEAREST `org_toolchain_default` walking caller → … → root
 *   else canary       → the NEAREST `toolchain_rollout` membership, served only
 *                       while it passes the scan + metadata guards
 *   else platform     → `toolchain_platform_default`
 *   else              → 409 TOOLCHAIN_NO_DEFAULT (never "highest version", D11)
 *
 * - Reads are ELEVATED (`runWithTenantContext({ isSuperAdmin: true })`, as
 *   `versionReferences` does) and touch SYSTEM-ORG plugin rows only: the owner
 *   rank of `pluginResolutionOrderBy` is never consulted, so a same-named row in
 *   any other org is never a candidate.
 * - Eligibility (D15) is a SET-time rule ({@link isEligibleRelease}); at resolve
 *   time a pin / org default only has to exist.
 * - Both halves always come from ONE release (`TOOLCHAIN_PAIR_MISMATCH` otherwise).
 * - The answer carries `resolvedVia` and nothing about any other org: no
 *   rollout membership, no ancestor's settings.
 */

import {
  AppError, compareSemver, createLogger, envInt, ErrorCode, fetchParentOrgId, getStatusForErrorCode, isSystemOrgId,
  MANAGED_TOOLCHAIN_PLUGINS, MAX_ORG_DEPTH, SYSTEM_ORG_ID, TOOLCHAIN_RELEASE_VERSION_PATTERN, toolchainFromMetadata, toOrgIdString,
  type GetParentOrgId, type ManagedToolchainPlugin, type PluginToolchain,
} from '@pipeline-builder/api-core';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { CrudTx } from './crud-service.js';
import type { ResolutionRefusal } from './plugin-resolution.js';
import { schema, type OrgToolchainDefault, type Plugin, type ToolchainRelease } from '../database/drizzle-schema.js';
import { runWithTenantContext, withTenantTx } from '../database/tenancy.js';

const logger = createLogger('managed-toolchain');

// -----------------------------------------------------------------------------
// Public shapes
// -----------------------------------------------------------------------------

/** How a resolution chose its release. Never names the org it came from. */
export type ToolchainResolvedVia = 'pin' | 'org-default' | 'canary' | 'default';

/** A non-fatal note on a resolved release (synth prints it). */
export interface ManagedToolchainWarning {
  code: string;
  message: string;
  severity: 'info' | 'warning' | 'error';
}

/** One release, both halves. */
export interface ManagedToolchainResolution {
  releaseVersion: string;
  resolvedVia: ToolchainResolvedVia;
  bootstrap: Plugin;
  synth: Plugin;
  warnings: ManagedToolchainWarning[];
}

/** A resolver refusal: `code` is TOOLCHAIN_NO_DEFAULT, NOT_FOUND, TOOLCHAIN_PAIR_MISMATCH or VALIDATION_ERROR. */
export class ManagedToolchainError extends AppError {
  constructor(code: ErrorCode, message: string, details?: Record<string, unknown>) {
    super(getStatusForErrorCode(code), code, message, details);
    this.name = 'ManagedToolchainError';
  }
}

/** The caller a resolution runs for. */
export interface ManagedToolchainCaller {
  orgId: string;
}

/** Whether `version` is a release version (`MAJOR.MINOR.PATCH`). */
export function isToolchainReleaseVersion(version: unknown): version is string {
  return typeof version === 'string' && TOOLCHAIN_RELEASE_VERSION_PATTERN.test(version);
}

// -----------------------------------------------------------------------------
// Data access (system-org rows, elevated)
// -----------------------------------------------------------------------------

/** What the resolver reads with: a drizzle transaction (or any drizzle database in tests). */
export type ToolchainDb = Pick<CrudTx, 'select'>;

/** How the resolver reads and walks the org tree (injectable for tests). */
export interface ManagedToolchainDeps {
  /** Run `fn` with ELEVATED reads. */
  read<T>(fn: (db: ToolchainDb) => Promise<T>): Promise<T>;
  /** An org's direct parent, or undefined for a root. Throws when it can't tell. */
  getParent: GetParentOrgId;
}

/** Both halves of one release as stored, with the release row. */
export interface ReleaseHalves {
  releaseVersion: string;
  release: ToolchainRelease | null;
  bootstrap: Plugin | null;
  synth: Plugin | null;
}

const BOOTSTRAP: ManagedToolchainPlugin = 'pipeline-bootstrap';
const SYNTH: ManagedToolchainPlugin = 'cdk-synth';

/** The release row and both SYSTEM-ORG halves of `releaseVersion` (deleted rows excluded). */
export async function loadReleaseHalves(db: ToolchainDb, releaseVersion: string): Promise<ReleaseHalves> {
  const [releases, rows] = await Promise.all([
    db.select().from(schema.toolchainRelease).where(eq(schema.toolchainRelease.releaseVersion, releaseVersion)),
    db.select().from(schema.plugin).where(and(
      sql`lower(${schema.plugin.orgId}) = ${SYSTEM_ORG_ID}`,
      inArray(schema.plugin.name, [...MANAGED_TOOLCHAIN_PLUGINS]),
      eq(schema.plugin.version, releaseVersion),
      isNull(schema.plugin.deletedAt),
    )),
  ]);
  const plugins = rows as Plugin[];
  return {
    releaseVersion,
    release: (releases as ToolchainRelease[])[0] ?? null,
    bootstrap: plugins.find((p) => p.name === BOOTSTRAP) ?? null,
    synth: plugins.find((p) => p.name === SYNTH) ?? null,
  };
}

/** A setting found on the caller's chain: which chain index, and its release. */
interface ChainSetting { depth: number; releaseVersion: string }

/** The NEAREST row of `table` (keyed by `org_id`) on `chain` (own org first). */
async function nearestOnChain(
  db: ToolchainDb,
  table: typeof schema.orgToolchainDefault | typeof schema.toolchainRollout,
  chain: readonly string[],
): Promise<ChainSetting | null> {
  if (chain.length === 0) return null;
  const rows = await db.select({ orgId: table.orgId, releaseVersion: table.releaseVersion })
    .from(table)
    .where(inArray(sql<string>`lower(${table.orgId})`, [...chain])) as Array<{ orgId: string; releaseVersion: string }>;
  let best: ChainSetting | null = null;
  for (const r of rows) {
    const depth = chain.indexOf(r.orgId.toLowerCase());
    if (depth >= 0 && (!best || depth < best.depth)) best = { depth, releaseVersion: r.releaseVersion };
  }
  return best;
}

async function currentPlatformDefault(db: ToolchainDb): Promise<string | null> {
  const rows = await db.select({ releaseVersion: schema.toolchainPlatformDefault.releaseVersion })
    .from(schema.toolchainPlatformDefault).limit(1) as Array<{ releaseVersion: string }>;
  return rows[0]?.releaseVersion ?? null;
}

/** Whether `releaseVersion` has ever been (or is) the platform default. */
async function wasPlatformDefault(db: ToolchainDb, releaseVersion: string): Promise<boolean> {
  const [history, current] = await Promise.all([
    db.select({ id: schema.toolchainDefaultHistory.id }).from(schema.toolchainDefaultHistory)
      .where(eq(schema.toolchainDefaultHistory.releaseVersion, releaseVersion)).limit(1),
    currentPlatformDefault(db),
  ]);
  return (history as unknown[]).length > 0 || current === releaseVersion;
}

/** Whether ANY org has an org default or a canary membership (else no walk is needed). */
async function anyOrgSettings(db: ToolchainDb): Promise<boolean> {
  const [defaults, rollout] = await Promise.all([
    db.select({ orgId: schema.orgToolchainDefault.orgId }).from(schema.orgToolchainDefault).limit(1),
    db.select({ orgId: schema.toolchainRollout.orgId }).from(schema.toolchainRollout).limit(1),
  ]);
  return (defaults as unknown[]).length > 0 || (rollout as unknown[]).length > 0;
}

// -----------------------------------------------------------------------------
// The org chain (caller → … → root)
// -----------------------------------------------------------------------------

/**
 * The caller's chain, own org first, lowercased: `[self, parent, …, root]`.
 * The same parent walk as `org-reachability.ts` (platform's
 * `GET /organization/:id/parent`), cycle-safe and capped at `MAX_ORG_DEPTH` like
 * `reporting-retention.ts` — but FAIL-CLOSED: a lookup failure, a cycle or an
 * over-deep chain throws rather than resolving the wrong org's toolchain.
 */
export async function toolchainOrgChain(orgId: string, getParent: GetParentOrgId): Promise<string[]> {
  const self = orgId.toLowerCase();
  const chain = [self];
  if (isSystemOrgId(self)) return chain;
  let current = self;
  for (let depth = 0; depth < MAX_ORG_DEPTH; depth++) {
    const parent = toOrgIdString(await getParent(current))?.toLowerCase();
    if (!parent || parent === current) return chain;
    if (chain.includes(parent)) {
      throw new ManagedToolchainError(ErrorCode.INTERNAL_ERROR, 'The organization hierarchy has a cycle; the toolchain release cannot be resolved.', { orgId: self });
    }
    chain.push(parent);
    current = parent;
  }
  throw new ManagedToolchainError(ErrorCode.INTERNAL_ERROR, `The organization hierarchy is deeper than ${MAX_ORG_DEPTH}; the toolchain release cannot be resolved.`, { orgId: self });
}

/** Parent lookups are cached briefly: one synth makes several lookups for the same org. */
const PARENT_CACHE_TTL_MS = 30_000;
const PARENT_CACHE_MAX = 5_000;
const parentCache = new Map<string, { parent: string | undefined; at: number }>();

async function platformParent(orgId: string): Promise<string | undefined> {
  const hit = parentCache.get(orgId);
  if (hit && Date.now() - hit.at < PARENT_CACHE_TTL_MS) return hit.parent;
  // A system-scoped service token; a non-2xx THROWS (fail-closed, see toolchainOrgChain).
  const parent = await fetchParentOrgId(orgId, { authOrgId: SYSTEM_ORG_ID, throwOnHttpError: true, timeout: 5_000 });
  if (parentCache.size >= PARENT_CACHE_MAX) parentCache.clear();
  parentCache.set(orgId, { parent, at: Date.now() });
  return parent;
}

/** Test hook: drop cached parent lookups. */
export function clearToolchainParentCacheForTests(): void {
  parentCache.clear();
}

const productionDeps: ManagedToolchainDeps = {
  read: (fn) => runWithTenantContext({ isSuperAdmin: true }, () => withTenantTx((tx) => fn(tx))),
  getParent: platformParent,
};
let defaultDeps: ManagedToolchainDeps = productionDeps;

/** Test hook: replace the resolver's reads and hierarchy (null restores production). */
export function setManagedToolchainDepsForTests(deps: ManagedToolchainDeps | null): void {
  defaultDeps = deps ?? productionDeps;
}

// -----------------------------------------------------------------------------
// Lifecycle, eligibility and the canary guards
// -----------------------------------------------------------------------------

/** Why a stored release is not LIVE (empty = live: both halves present, active, unyanked, not deprecated). */
export type ReleaseLifecycleProblem = 'missing' | 'inactive' | 'yanked' | 'deprecated';

const isYanked = (p: Plugin) => p.yankedAt !== null || p.lifecycle === 'yanked';
const isDeprecated = (p: Plugin) => p.deprecatedAt !== null || p.lifecycle === 'deprecated';

/** Whether both halves are present (the release EXISTS). */
export function releaseExists(h: ReleaseHalves): h is ReleaseHalves & { bootstrap: Plugin; synth: Plugin } {
  return h.release !== null && h.bootstrap !== null && h.synth !== null;
}

export function releaseLifecycleProblems(h: ReleaseHalves): ReleaseLifecycleProblem[] {
  if (!releaseExists(h)) return ['missing'];
  const halves = [h.bootstrap, h.synth];
  const out: ReleaseLifecycleProblem[] = [];
  if (halves.some((p) => !p.isActive)) out.push('inactive');
  if (halves.some(isYanked)) out.push('yanked');
  if (halves.some(isDeprecated)) out.push('deprecated');
  return out;
}

/**
 * The bootstrap half's toolchain metadata (`pipelineManager`, `awsCdk`, …), or
 * null when it carries no complete, valid one. Upload persists it on the row's
 * `metadata` as flat `toolchain.<field>` keys (api-core `toolchainMetadata`).
 */
export function bootstrapToolchainOf(row: Plugin | null | undefined): PluginToolchain | null {
  return row ? toolchainFromMetadata(row.metadata) : null;
}

/** `PLUGIN_VULN_MAX_FINDINGS` (default 0): the fixable-Critical floor a release must be within. */
function vulnFloor(): number {
  return envInt('PLUGIN_VULN_MAX_FINDINGS', 0, { min: 0 });
}

/**
 * The §8 candidate guards (pair, scan, metadata) a release fails, as their
 * error codes — empty when it passes. The canary gate and concurrency are the
 * platform-default service's; a canary is served only while this is empty.
 */
export function toolchainCandidateProblems(h: ReleaseHalves): ErrorCode[] {
  if (!releaseExists(h) || releaseLifecycleProblems(h).length > 0) return [ErrorCode.TOOLCHAIN_GUARD_PAIR_INCOMPLETE];
  const out: ErrorCode[] = [];
  const halves = [h.bootstrap, h.synth];
  if (halves.some((p) => !p.scannedAt)) out.push(ErrorCode.TOOLCHAIN_GUARD_UNSCANNED);
  else if (halves.some((p) => (p.vulnCriticalFixable ?? 0) > vulnFloor())) out.push(ErrorCode.TOOLCHAIN_GUARD_VULN_FLOOR);
  if (!bootstrapToolchainOf(h.bootstrap)) out.push(ErrorCode.TOOLCHAIN_GUARD_METADATA);
  return out;
}

/** Warnings for a release that EXISTS but is no longer (or never was) eligible. */
function standingWarnings(h: ReleaseHalves & { bootstrap: Plugin; synth: Plugin }, promoted: boolean, via: ToolchainResolvedVia): ManagedToolchainWarning[] {
  const ref = `Toolchain release ${h.releaseVersion}`;
  const out: ManagedToolchainWarning[] = [];
  const yanked = [h.bootstrap, h.synth].find(isYanked);
  if (yanked) {
    out.push({
      code: 'TOOLCHAIN_RELEASE_YANKED',
      severity: 'warning',
      message: `${ref} is yanked${yanked.yankReason ? `: ${yanked.yankReason}` : ''}. It resolves only because it is selected exactly; move to a supported release.`,
    });
  }
  const deprecated = [h.bootstrap, h.synth].find(isDeprecated);
  if (deprecated) {
    out.push({
      code: 'TOOLCHAIN_RELEASE_DEPRECATED',
      severity: 'warning',
      message: `${ref} is deprecated${deprecated.deprecationMessage ? `: ${deprecated.deprecationMessage}` : ''}.`,
    });
  }
  if ([h.bootstrap, h.synth].some((p) => !p.isActive)) {
    out.push({ code: 'TOOLCHAIN_RELEASE_INACTIVE', severity: 'warning', message: `${ref} is inactive; move to a supported release.` });
  }
  if (!promoted && (via === 'pin' || via === 'org-default')) {
    out.push({
      code: 'TOOLCHAIN_RELEASE_NOT_PROMOTED',
      severity: 'warning',
      message: `${ref} was never the platform default and is not in a canary for your organization; it resolves only because it is selected exactly.`,
    });
  }
  return out;
}

// -----------------------------------------------------------------------------
// Resolution
// -----------------------------------------------------------------------------

function pairOf(h: ReleaseHalves, via: ToolchainResolvedVia): { bootstrap: Plugin; synth: Plugin } {
  if (!releaseExists(h)) {
    // A default (platform or org) whose halves are gone is a broken invariant
    // (in-use protection counts defaults): refused, never served.
    throw new ManagedToolchainError(ErrorCode.TOOLCHAIN_PAIR_MISMATCH, `Toolchain release ${h.releaseVersion} (${via}) is incomplete; it is never served.`, {
      releaseVersion: h.releaseVersion,
      missing: [...(h.bootstrap ? [] : [BOOTSTRAP]), ...(h.synth ? [] : [SYNTH]), ...(h.release ? [] : ['toolchain_release'])],
    });
  }
  if (h.bootstrap.version !== h.releaseVersion || h.synth.version !== h.releaseVersion) {
    throw new ManagedToolchainError(ErrorCode.TOOLCHAIN_PAIR_MISMATCH, `Toolchain halves disagree (${BOOTSTRAP}@${h.bootstrap.version}, ${SYNTH}@${h.synth.version}); never served.`, {
      releaseVersion: h.releaseVersion,
    });
  }
  return { bootstrap: h.bootstrap, synth: h.synth };
}

/** The resolution inside one elevated read, over a known chain. */
async function resolveOnChain(db: ToolchainDb, chain: readonly string[], releasePin?: string): Promise<ManagedToolchainResolution> {
  const canary = await nearestOnChain(db, schema.toolchainRollout, chain);
  const answer = async (h: ReleaseHalves, via: ToolchainResolvedVia): Promise<ManagedToolchainResolution> => {
    const pair = pairOf(h, via);
    const promoted = via === 'pin' || via === 'org-default'
      ? (await wasPlatformDefault(db, h.releaseVersion)) || canary?.releaseVersion === h.releaseVersion
      : true;
    return { releaseVersion: h.releaseVersion, resolvedVia: via, ...pair, warnings: standingWarnings({ ...h, ...pair }, promoted, via) };
  };

  if (releasePin !== undefined) {
    if (!isToolchainReleaseVersion(releasePin)) {
      throw new ManagedToolchainError(ErrorCode.VALIDATION_ERROR, 'releasePin must be a release version (MAJOR.MINOR.PATCH, e.g. 1.4.2).', { releasePin });
    }
    const h = await loadReleaseHalves(db, releasePin);
    if (!releaseExists(h)) {
      throw new ManagedToolchainError(ErrorCode.NOT_FOUND, `Toolchain release ${releasePin} does not exist (or was deleted). Pin an eligible release, or remove toolchain.release to follow your organization's default.`, {
        reason: 'toolchain_release_not_found', releaseVersion: releasePin,
      });
    }
    return answer(h, 'pin');
  }

  const orgDefault = await nearestOnChain(db, schema.orgToolchainDefault, chain);
  if (orgDefault) return answer(await loadReleaseHalves(db, orgDefault.releaseVersion), 'org-default');

  if (canary) {
    const h = await loadReleaseHalves(db, canary.releaseVersion);
    const problems = toolchainCandidateProblems(h);
    if (problems.length === 0) return answer(h, 'canary');
    // Members fall through to the platform default. Logged, never returned:
    // the answer must not reveal canary membership.
    logger.warn('Canary toolchain release fails its guards; serving the platform default', { releaseVersion: canary.releaseVersion, problems });
  }

  const platform = await currentPlatformDefault(db);
  if (!platform) {
    throw new ManagedToolchainError(ErrorCode.TOOLCHAIN_NO_DEFAULT, 'No platform default toolchain release is set. An operator must set one (init-platform does this on a fresh install).');
  }
  return answer(await loadReleaseHalves(db, platform), 'default');
}

/** {@link resolveManagedToolchain} with injected reads and hierarchy (tests). */
export async function resolveManagedToolchainWith(
  deps: ManagedToolchainDeps,
  caller: ManagedToolchainCaller,
  opts: { releasePin?: string } = {},
): Promise<ManagedToolchainResolution> {
  const self = caller.orgId.toLowerCase();
  // Walk the hierarchy only when some org has a setting (and outside the transaction).
  const walk = await deps.read((db) => anyOrgSettings(db));
  const chain = walk ? await toolchainOrgChain(self, deps.getParent) : [self];
  return deps.read((db) => resolveOnChain(db, chain, opts.releasePin));
}

/**
 * Resolve the managed toolchain release for `caller` (see the module doc).
 * Throws {@link ManagedToolchainError}: TOOLCHAIN_NO_DEFAULT (409, no platform
 * default), NOT_FOUND (404, a missing / deleted pin), TOOLCHAIN_PAIR_MISMATCH
 * (500), VALIDATION_ERROR (400, a malformed pin).
 */
export function resolveManagedToolchain(caller: ManagedToolchainCaller, opts: { releasePin?: string } = {}): Promise<ManagedToolchainResolution> {
  return resolveManagedToolchainWith(defaultDeps, caller, opts);
}

/** {@link isEligibleRelease} with injected reads and hierarchy (tests). */
export async function isEligibleReleaseWith(deps: ManagedToolchainDeps, orgId: string, releaseVersion: string): Promise<boolean> {
  if (!isToolchainReleaseVersion(releaseVersion)) return false;
  const self = orgId.toLowerCase();
  const halves = await deps.read((db) => loadReleaseHalves(db, releaseVersion));
  if (releaseLifecycleProblems(halves).length > 0) return false;
  if (await deps.read((db) => wasPlatformDefault(db, releaseVersion))) return true;
  const walk = await deps.read((db) => anyOrgSettings(db));
  if (!walk) return false;
  const chain = await toolchainOrgChain(self, deps.getParent);
  const canary = await deps.read((db) => nearestOnChain(db, schema.toolchainRollout, chain));
  return canary?.releaseVersion === releaseVersion;
}

/**
 * D15: whether `orgId` may SET `releaseVersion` as a pipeline pin or its org
 * default — both halves live (active, unyanked, not deprecated) AND either it
 * has been the platform default or it is the caller's canary (nearest
 * membership on its chain).
 */
export function isEligibleRelease(orgId: string, releaseVersion: string): Promise<boolean> {
  return isEligibleReleaseWith(defaultDeps, orgId, releaseVersion);
}

// -----------------------------------------------------------------------------
// The org's own picture: the org-default panel and the eligible-release list
// (docs/plans/bootstrap-image-versioning.md §5, Phase 4, D15)
// -----------------------------------------------------------------------------

/**
 * What the org-default panel shows a caller about ITS OWN org: never another
 * org's choice, and of the ancestors only which one's default applies.
 */
export interface OrgToolchainOverview {
  /** The caller's chain, own org first (lowercased). */
  chain: string[];
  /** What the org's UNPINNED pipelines resolve to now. */
  effective: { releaseVersion: string; resolvedVia: ToolchainResolvedVia; warnings: ManagedToolchainWarning[] };
  /** The caller org's own `org_toolchain_default` row, if it set one. */
  ownDefault: OrgToolchainDefault | null;
  /** The ancestor whose org default applies, when the org set none of its own. */
  inheritedFrom: { orgId: string; releaseVersion: string } | null;
  /** The caller's canary release (its NEAREST membership on the chain), or null. */
  canaryRelease: string | null;
  platformDefault: string | null;
}

/** {@link readOrgToolchainOverview} with injected reads and hierarchy (tests). */
export async function readOrgToolchainOverviewWith(deps: ManagedToolchainDeps, orgId: string): Promise<OrgToolchainOverview> {
  const self = orgId.toLowerCase();
  const walk = await deps.read((db) => anyOrgSettings(db));
  const chain = walk ? await toolchainOrgChain(self, deps.getParent) : [self];
  return deps.read(async (db) => {
    const rows = await db.select().from(schema.orgToolchainDefault)
      .where(inArray(sql<string>`lower(${schema.orgToolchainDefault.orgId})`, chain)) as OrgToolchainDefault[];
    const depthOf = (r: OrgToolchainDefault) => chain.indexOf(r.orgId.toLowerCase());
    const ownDefault = rows.find((r) => depthOf(r) === 0) ?? null;
    const nearest = rows.filter((r) => depthOf(r) >= 0).sort((a, b) => depthOf(a) - depthOf(b))[0] ?? null;
    const [canary, platformDefault, resolution] = await Promise.all([
      nearestOnChain(db, schema.toolchainRollout, chain),
      currentPlatformDefault(db),
      resolveOnChain(db, chain),
    ]);
    return {
      chain,
      effective: { releaseVersion: resolution.releaseVersion, resolvedVia: resolution.resolvedVia, warnings: resolution.warnings },
      ownDefault,
      inheritedFrom: !ownDefault && nearest ? { orgId: nearest.orgId, releaseVersion: nearest.releaseVersion } : null,
      canaryRelease: canary?.releaseVersion ?? null,
      platformDefault,
    };
  });
}

/**
 * The caller org's toolchain overview (elevated reads, the same chain walk and
 * precedence as {@link resolveManagedToolchain}). Throws what the resolver
 * throws — TOOLCHAIN_NO_DEFAULT (409) when nothing resolves at all.
 */
export function readOrgToolchainOverview(orgId: string): Promise<OrgToolchainOverview> {
  return readOrgToolchainOverviewWith(defaultDeps, orgId);
}

/** One release the caller may pin or set (D15), with what the selectors show. */
export interface EligibleToolchainRelease {
  releaseVersion: string;
  release: ToolchainRelease;
  bootstrap: Plugin;
  synth: Plugin;
  /** THE platform default now. */
  isPlatformDefault: boolean;
  /** The caller's canary release (nearest membership). */
  isCanary: boolean;
}

/** {@link listEligibleReleases} with injected reads and hierarchy (tests). */
export async function listEligibleReleasesWith(deps: ManagedToolchainDeps, orgId: string): Promise<{ platformDefault: string | null; releases: EligibleToolchainRelease[] }> {
  const self = orgId.toLowerCase();
  const walk = await deps.read((db) => anyOrgSettings(db));
  const chain = walk ? await toolchainOrgChain(self, deps.getParent) : [self];
  return deps.read(async (db) => {
    const [releases, rows, history, platformDefault, canary] = await Promise.all([
      db.select().from(schema.toolchainRelease) as Promise<ToolchainRelease[]>,
      db.select().from(schema.plugin).where(and(
        sql`lower(${schema.plugin.orgId}) = ${SYSTEM_ORG_ID}`,
        inArray(schema.plugin.name, [...MANAGED_TOOLCHAIN_PLUGINS]),
        isNull(schema.plugin.deletedAt),
      )) as Promise<Plugin[]>,
      db.select({ releaseVersion: schema.toolchainDefaultHistory.releaseVersion }).from(schema.toolchainDefaultHistory) as Promise<Array<{ releaseVersion: string }>>,
      currentPlatformDefault(db),
      nearestOnChain(db, schema.toolchainRollout, chain),
    ]);
    const promoted = new Set(history.map((h) => h.releaseVersion));
    if (platformDefault) promoted.add(platformDefault);
    const out: EligibleToolchainRelease[] = [];
    for (const release of releases) {
      const v = release.releaseVersion;
      const halves: ReleaseHalves = {
        releaseVersion: v,
        release,
        bootstrap: rows.find((p) => p.name === BOOTSTRAP && p.version === v) ?? null,
        synth: rows.find((p) => p.name === SYNTH && p.version === v) ?? null,
      };
      if (!releaseExists(halves) || releaseLifecycleProblems(halves).length > 0) continue;
      const isCanary = canary?.releaseVersion === v;
      if (!promoted.has(v) && !isCanary) continue;
      out.push({ releaseVersion: v, release, bootstrap: halves.bootstrap, synth: halves.synth, isPlatformDefault: platformDefault === v, isCanary });
    }
    out.sort((a, b) => compareSemver(b.releaseVersion, a.releaseVersion));
    return { platformDefault, releases: out };
  });
}

/**
 * Every release `orgId` may SET as a pipeline pin or its org default (D15, the
 * same rule as {@link isEligibleRelease}), newest first. Never another org's
 * data: a canary appears only when it is the caller's own (nearest) membership.
 */
export function listEligibleReleases(orgId: string): Promise<{ platformDefault: string | null; releases: EligibleToolchainRelease[] }> {
  return listEligibleReleasesWith(defaultDeps, orgId);
}

// -----------------------------------------------------------------------------
// Caller helpers
// -----------------------------------------------------------------------------

/** The resolver's error as the refusal shape step resolution reports (contract check, declared side, facts). */
export function managedToolchainRefusal(err: ManagedToolchainError): ResolutionRefusal {
  switch (err.code) {
    case ErrorCode.NOT_FOUND:
      return { code: 'NOT_FOUND', reason: 'toolchain_release_not_found', message: err.message, ...(err.details ? { details: err.details } : {}) };
    case ErrorCode.VALIDATION_ERROR:
      return { code: 'NOT_FOUND', reason: 'toolchain_release_invalid', message: err.message, ...(err.details ? { details: err.details } : {}) };
    case ErrorCode.TOOLCHAIN_NO_DEFAULT:
      return { code: 'PLUGIN_UNAVAILABLE', reason: 'toolchain_no_default', message: err.message };
    default:
      return { code: 'PLUGIN_UNAVAILABLE', reason: 'toolchain_unresolved', message: err.message, ...(err.details ? { details: err.details } : {}) };
  }
}

/**
 * Resolve ONE managed half for a step: the plugin row plus the resolution, or
 * the refusal. Any non-resolver error (a database or hierarchy failure)
 * propagates.
 */
export async function resolveManagedToolchainHalf(
  caller: ManagedToolchainCaller,
  name: ManagedToolchainPlugin,
  opts: { releasePin?: string } = {},
): Promise<{ plugin: Plugin; resolution: ManagedToolchainResolution } | { refusal: ResolutionRefusal; error: ManagedToolchainError }> {
  try {
    const resolution = await resolveManagedToolchain(caller, opts);
    return { plugin: name === BOOTSTRAP ? resolution.bootstrap : resolution.synth, resolution };
  } catch (err) {
    if (err instanceof ManagedToolchainError) return { refusal: managedToolchainRefusal(err), error: err };
    throw err;
  }
}
