// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The Toolchain CONSOLE service (docs/plans/bootstrap-image-versioning.md §5,
 * §6, §8, §9, §10, §11, D9, Phase 5): the system org's view of every managed
 * toolchain release across every org, and the operator actions on it.
 *
 * It wraps, never re-implements, the Phase 2-4 services:
 *  - the platform default moves ONLY through `setPlatformDefault` (§8 guards);
 *    the default-preview reads the same guard evaluation without writing;
 *  - deprecate / yank / delete are `toolchain-release-service`'s;
 *  - the canary gate and the Affected view are pipeline-data's run-row queries;
 *  - notices go through toolchain-hygiene's N34 path.
 *
 * Every read here is ELEVATED (it spans every org, like `versionReferences`).
 * The routes authorize first: system org + `toolchain:operate` + aal2, and a
 * step-up on every write (routes/toolchain-console.ts). Org NAMES come from the
 * platform's `POST /organization/names` (system-scoped service token), best-
 * effort: an unresolved id is shown as its id.
 */

import {
  AppError, ConflictError, compareSemver, createLogger, errorMessage, ErrorCode, fetchOrgNames, fetchParentOrgId, getStatusForErrorCode,
  lastScannedAt, MANAGED_TOOLCHAIN_PLUGINS, NotFoundError, recordAudit, SYSTEM_ORG_ID, toolchainFromMetadata, ValidationError,
  BUILD_IMAGE_STEP_KEY,
  type GetParentOrgId, type PluginScanSummary, type PluginToolchain,
} from '@pipeline-builder/api-core';
import {
  executeRows, loadReleaseHalves, readAffectedPipelines, readCanaryGate, readPlatformDefaultRelease, runWithTenantContext, schema,
  toolchainCandidateProblems, toolchainOrgChain, withTenantTx,
  type CanaryGateParams, type CanaryGateResult, type ToolchainResolvedVia,
} from '@pipeline-builder/pipeline-data';
import { and, desc, eq, inArray, isNull, ne, sql } from 'drizzle-orm';

import type { Plugin } from './plugin-service.js';
import { announceToolchain, type RecoveryPipeline } from './toolchain-hygiene.js';
import {
  deleteRelease, deprecateRelease, previewPlatformDefaultGuards, setPlatformDefault, yankRelease, type ToolchainActor,
} from './toolchain-release-service.js';

const logger = createLogger('toolchain-console');

type TenantTx = Parameters<Parameters<typeof withTenantTx>[0]>[0];

/** K: the Cleanup panel keeps every release no older than the last K platform defaults. */
export const CLEANUP_KEEP_DEFAULTS = 5;

const BOOTSTRAP = 'pipeline-bootstrap';
const SYNTH = 'cdk-synth';
const MANAGED_NAMES_SQL = sql.raw(MANAGED_TOOLCHAIN_PLUGINS.map((n) => `'${n}'`).join(', '));

// -----------------------------------------------------------------------------
// Dependencies (injectable for tests)
// -----------------------------------------------------------------------------

export interface ToolchainConsoleDeps {
  /** id → name (lowercased ids); ids it can't resolve are absent. Never throws. */
  orgNames(orgIds: string[]): Promise<Record<string, string>>;
  /** An org's direct parent (undefined for a root). Throws when it can't tell. */
  getParent: GetParentOrgId;
}

const productionDeps: ToolchainConsoleDeps = {
  orgNames: async (orgIds) => {
    try {
      return await fetchOrgNames(orgIds, { authOrgId: SYSTEM_ORG_ID, timeout: 5_000 });
    } catch (err) {
      logger.warn('Org name lookup failed; showing ids', { error: errorMessage(err) });
      return {};
    }
  },
  getParent: (orgId) => fetchParentOrgId(orgId, { authOrgId: SYSTEM_ORG_ID, throwOnHttpError: true, timeout: 5_000 }),
};
let deps: ToolchainConsoleDeps = productionDeps;

/** Test hook: replace the name lookup and the hierarchy (null restores production). */
export function setToolchainConsoleDepsForTests(d: ToolchainConsoleDeps | null): void {
  deps = d ?? productionDeps;
}

function elevated<T>(fn: (tx: TenantTx) => Promise<T>): Promise<T> {
  return runWithTenantContext({ isSuperAdmin: true }, () => withTenantTx(fn));
}

const lower = (id: string) => id.toLowerCase();

/** id → display name, the id itself when the platform can't name it. */
async function namesFor(orgIds: Iterable<string>): Promise<(orgId: string) => string> {
  const ids = [...new Set([...orgIds].map(lower))];
  const names = ids.length > 0 ? await deps.orgNames(ids) : {};
  return (orgId) => names[lower(orgId)] ?? orgId;
}

// -----------------------------------------------------------------------------
// Which orgs follow the platform default (the resolver's precedence, per org)
// -----------------------------------------------------------------------------

interface OrgSettings {
  defaults: Map<string, string>;
  rollout: Map<string, string>;
}

async function readOrgSettings(tx: TenantTx): Promise<OrgSettings> {
  const [defaults, rollout] = await Promise.all([
    tx.select({ orgId: schema.orgToolchainDefault.orgId, releaseVersion: schema.orgToolchainDefault.releaseVersion }).from(schema.orgToolchainDefault),
    tx.select({ orgId: schema.toolchainRollout.orgId, releaseVersion: schema.toolchainRollout.releaseVersion }).from(schema.toolchainRollout),
  ]);
  return {
    defaults: new Map(defaults.map((r) => [lower(r.orgId), r.releaseVersion])),
    rollout: new Map(rollout.map((r) => [lower(r.orgId), r.releaseVersion])),
  };
}

/** How an org's UNPINNED pipelines resolve, without the resolver's guard fall-through. */
export interface OrgClassification {
  via: Exclude<ToolchainResolvedVia, 'pin'>;
  /** The org default (own or inherited) or canary release; null when following the platform default. */
  releaseVersion: string | null;
}

/**
 * Classify each org by the resolver's precedence — nearest org default on its
 * chain, else nearest canary membership, else the platform default. Walks the
 * hierarchy only when some org has a setting, once per org (memoized parent
 * lookups), and OUTSIDE any transaction. A failed walk falls back to the org's
 * own rows (logged): this is a console estimate, not a resolution.
 */
async function classifyOrgs(orgIds: Iterable<string>, settings: OrgSettings): Promise<Map<string, OrgClassification>> {
  const out = new Map<string, OrgClassification>();
  const any = settings.defaults.size > 0 || settings.rollout.size > 0;
  const parents = new Map<string, Promise<string | undefined>>();
  const getParent: GetParentOrgId = (id) => {
    let p = parents.get(id);
    if (!p) { p = Promise.resolve(deps.getParent(id)); parents.set(id, p); }
    return p;
  };
  for (const raw of new Set([...orgIds].map(lower))) {
    if (!any) { out.set(raw, { via: 'default', releaseVersion: null }); continue; }
    let chain = [raw];
    if (!settings.defaults.has(raw)) {
      try {
        chain = await toolchainOrgChain(raw, getParent);
      } catch (err) {
        logger.warn('Org hierarchy walk failed; classifying by the org\'s own settings', { orgId: raw, error: errorMessage(err) });
      }
    }
    const nearest = (m: Map<string, string>) => chain.map((id) => m.get(id)).find((v) => v !== undefined) ?? null;
    const orgDefault = nearest(settings.defaults);
    const canary = orgDefault ? null : nearest(settings.rollout);
    out.set(raw, orgDefault
      ? { via: 'org-default', releaseVersion: orgDefault }
      : canary ? { via: 'canary', releaseVersion: canary } : { via: 'default', releaseVersion: null });
  }
  return out;
}

/** Live pipelines per org: unpinned and pinned (`props.toolchain.release`). */
async function pipelinesByOrg(tx: TenantTx): Promise<Map<string, { unpinned: number; pinned: number }>> {
  const rows = await executeRows<{ org_id: string; unpinned: string | number; pinned: string | number }>(tx, sql`
    SELECT lower(org_id) AS org_id,
           count(*) FILTER (WHERE props->'toolchain'->>'release' IS NULL) AS unpinned,
           count(*) FILTER (WHERE props->'toolchain'->>'release' IS NOT NULL) AS pinned
      FROM pipelines WHERE deleted_at IS NULL GROUP BY 1
  `);
  return new Map(rows.map((r) => [r.org_id, { unpinned: Number(r.unpinned), pinned: Number(r.pinned) }]));
}

// -----------------------------------------------------------------------------
// Releases panel
// -----------------------------------------------------------------------------

export type ConsoleReleaseStatus = 'default' | 'canary' | 'available' | 'deprecated' | 'yanked';

export interface ConsoleHalfScan { scannedAt: string; criticalFixable: number; highFixable: number; kev: number }
export interface ConsoleHalf { digest: string | null; scan: ConsoleHalfScan | null }

export interface ConsoleRelease {
  releaseVersion: string;
  status: ConsoleReleaseStatus;
  /** The release row and both halves exist, and both are active. */
  complete: boolean;
  createdAt: string | null;
  releaseNotes: string | null;
  toolchain: PluginToolchain | null;
  halves: { bootstrap: ConsoleHalf | null; synth: ConsoleHalf | null };
  canaryOrgCount: number;
}

const isYanked = (p: Plugin) => p.yankedAt !== null || p.lifecycle === 'yanked';
const isDeprecated = (p: Plugin) => p.deprecatedAt !== null || p.lifecycle === 'deprecated';

function halfView(p: Plugin | null | undefined): ConsoleHalf | null {
  if (!p) return null;
  const scannedAt = lastScannedAt(p);
  const s = p.scanSummary as PluginScanSummary | null;
  return {
    digest: p.imageDigest ?? null,
    scan: scannedAt === null ? null : {
      scannedAt: scannedAt.toISOString(),
      criticalFixable: s?.criticalFixable ?? p.vulnCriticalFixable ?? 0,
      highFixable: s?.highFixable ?? p.vulnHighFixable ?? 0,
      kev: s?.kev ?? 0,
    },
  };
}

function statusOf(v: string, platformDefault: string | null, halves: Plugin[], canaryOrgs: number): ConsoleReleaseStatus {
  if (v === platformDefault) return 'default';
  if (halves.some(isYanked)) return 'yanked';
  if (halves.some(isDeprecated)) return 'deprecated';
  if (canaryOrgs > 0) return 'canary';
  return 'available';
}

/** `GET /plugins/toolchain/releases` — every release (registered or with a live half), newest first. */
export async function listConsoleReleases(): Promise<{ platformDefault: string | null; releases: ConsoleRelease[] }> {
  return elevated(async (tx) => {
    const [releases, plugins, platformDefault, rollout] = await Promise.all([
      tx.select().from(schema.toolchainRelease),
      tx.select().from(schema.plugin).where(and(
        eq(schema.plugin.orgId, SYSTEM_ORG_ID),
        inArray(schema.plugin.name, [...MANAGED_TOOLCHAIN_PLUGINS]),
        isNull(schema.plugin.deletedAt),
      )) as Promise<Plugin[]>,
      readPlatformDefaultRelease(tx),
      executeRows<{ release_version: string; n: string | number }>(tx, sql`SELECT release_version, count(*) AS n FROM toolchain_rollout GROUP BY 1`),
    ]);
    const canary = new Map(rollout.map((r) => [r.release_version, Number(r.n)]));
    const rowOf = new Map(releases.map((r) => [r.releaseVersion, r]));
    const versions = new Set<string>([...rowOf.keys(), ...plugins.map((p) => p.version)]);
    const out: ConsoleRelease[] = [];
    for (const v of versions) {
      const row = rowOf.get(v) ?? null;
      const bootstrap = plugins.find((p) => p.name === BOOTSTRAP && p.version === v) ?? null;
      const synth = plugins.find((p) => p.name === SYNTH && p.version === v) ?? null;
      const halves = [bootstrap, synth].filter((p): p is Plugin => p !== null);
      const canaryOrgCount = canary.get(v) ?? 0;
      out.push({
        releaseVersion: v,
        status: statusOf(v, platformDefault, halves, canaryOrgCount),
        complete: row !== null && bootstrap !== null && synth !== null && bootstrap.isActive && synth.isActive,
        createdAt: (row?.createdAt ?? bootstrap?.createdAt ?? synth?.createdAt ?? null)?.toISOString() ?? null,
        releaseNotes: row?.releaseNotes ?? null,
        toolchain: bootstrap ? toolchainFromMetadata(bootstrap.metadata) : null,
        halves: { bootstrap: halfView(bootstrap), synth: halfView(synth) },
        canaryOrgCount,
      });
    }
    out.sort((a, b) => compareSemver(b.releaseVersion, a.releaseVersion));
    return { platformDefault, releases: out };
  });
}

/** 404 unless the release is registered or has a live half. */
async function requireKnownRelease(tx: TenantTx, releaseVersion: string): Promise<void> {
  const h = await loadReleaseHalves(tx, releaseVersion);
  if (!h.release && !h.bootstrap && !h.synth) throw new NotFoundError(`Toolchain release ${releaseVersion} not found`);
}

// -----------------------------------------------------------------------------
// Adoption panel
// -----------------------------------------------------------------------------

export interface ReleaseAdoption {
  releaseVersion: string;
  /** DEPLOYED pipelines on the release (their manifest's build-image row), by how synth chose it. */
  byResolvedVia: Record<ToolchainResolvedVia, number>;
  orgs: Array<{ orgId: string; orgName: string; pipelines: number; pinned: number; orgDefault: boolean }>;
}

/**
 * `GET /plugins/toolchain/releases/:v/adoption` — across every org: pipelines
 * whose deployed manifest records the release (by `resolvedVia`), live
 * pipelines pinning it, and orgs whose own default it is.
 */
export async function getReleaseAdoption(releaseVersion: string): Promise<ReleaseAdoption> {
  const { deployed, pinned, defaults } = await elevated(async (tx) => {
    await requireKnownRelease(tx, releaseVersion);
    return {
      deployed: await executeRows<{ org_id: string; via: string | null; n: string | number }>(tx, sql`
        SELECT lower(org_id) AS org_id, resolved_via AS via, count(DISTINCT pipeline_id) AS n
          FROM pipeline_step_manifests
         WHERE step_key = ${BUILD_IMAGE_STEP_KEY} AND plugin_name = ${BOOTSTRAP} AND plugin_publisher IS NULL AND plugin_version = ${releaseVersion}
         GROUP BY 1, 2`),
      pinned: await executeRows<{ org_id: string; n: string | number }>(tx, sql`
        SELECT lower(org_id) AS org_id, count(*) AS n FROM pipelines
         WHERE deleted_at IS NULL AND props->'toolchain'->>'release' = ${releaseVersion} GROUP BY 1`),
      defaults: await tx.select({ orgId: schema.orgToolchainDefault.orgId }).from(schema.orgToolchainDefault)
        .where(eq(schema.orgToolchainDefault.releaseVersion, releaseVersion)),
    };
  });
  const byResolvedVia: Record<ToolchainResolvedVia, number> = { 'pin': 0, 'org-default': 0, 'canary': 0, 'default': 0 };
  const orgs = new Map<string, { pipelines: number; pinned: number; orgDefault: boolean }>();
  const org = (id: string) => {
    const k = lower(id);
    let o = orgs.get(k);
    if (!o) { o = { pipelines: 0, pinned: 0, orgDefault: false }; orgs.set(k, o); }
    return o;
  };
  for (const r of deployed) {
    const n = Number(r.n);
    org(r.org_id).pipelines += n;
    if (r.via && r.via in byResolvedVia) byResolvedVia[r.via as ToolchainResolvedVia] += n;
  }
  for (const r of pinned) org(r.org_id).pinned += Number(r.n);
  for (const r of defaults) org(r.orgId).orgDefault = true;
  const name = await namesFor(orgs.keys());
  return {
    releaseVersion,
    byResolvedVia,
    orgs: [...orgs.entries()]
      .map(([orgId, o]) => ({ orgId, orgName: name(orgId), ...o }))
      .sort((a, b) => b.pipelines - a.pipelines || b.pinned - a.pinned || a.orgId.localeCompare(b.orgId)),
  };
}

// -----------------------------------------------------------------------------
// Canary panel
// -----------------------------------------------------------------------------

/** The console's N / M / T, as the routes take them. */
export interface CanaryThresholds { n: number; m: number; t: number }

export function gateParamsOf(t: Partial<CanaryThresholds> | undefined): Partial<CanaryGateParams> | undefined {
  if (!t) return undefined;
  const out: Partial<CanaryGateParams> = {};
  if (t.n !== undefined) out.minRuns = t.n;
  if (t.m !== undefined) out.minOrgs = t.m;
  if (t.t !== undefined) out.maxFailurePointsAboveDefault = t.t;
  return Object.keys(out).length > 0 ? out : undefined;
}

export interface CanaryMember { orgId: string; orgName: string; hasOrgDefault: boolean }

export interface CanaryGateView {
  passes: boolean;
  /** Counted synth runs (each org capped at ceil(N/M)). */
  runs: number;
  orgs: number;
  failureRate: number | null;
  defaultFailureRate: number;
  thresholds: CanaryThresholds;
  /** Every terminal synth run, before the cap. */
  totalRuns: number;
  perOrgCap: number;
  shortfalls: CanaryGateResult['shortfalls'];
  /** The release was the platform default before: promotion waives the gate. */
  waived: boolean;
  baselineReleaseVersion: string | null;
}

async function membersOf(releaseVersion: string, settings: OrgSettings): Promise<CanaryMember[]> {
  const memberIds = [...settings.rollout.entries()].filter(([, v]) => v === releaseVersion).map(([id]) => id).sort();
  const cls = await classifyOrgs(memberIds, { ...settings, rollout: new Map() });
  const name = await namesFor(memberIds);
  return memberIds.map((orgId) => ({ orgId, orgName: name(orgId), hasOrgDefault: cls.get(orgId)?.via === 'org-default' }));
}

/** `GET /plugins/toolchain/releases/:v/canary` — members and the §6 gate against the current default. */
export async function getCanary(releaseVersion: string, thresholds?: Partial<CanaryThresholds>): Promise<{ members: CanaryMember[]; gate: CanaryGateView }> {
  const { settings, gate, waived } = await elevated(async (tx) => {
    await requireKnownRelease(tx, releaseVersion);
    const current = await readPlatformDefaultRelease(tx);
    const [history] = await tx.select({ id: schema.toolchainDefaultHistory.id }).from(schema.toolchainDefaultHistory)
      .where(eq(schema.toolchainDefaultHistory.releaseVersion, releaseVersion)).limit(1);
    return {
      settings: await readOrgSettings(tx),
      gate: await readCanaryGate(tx, releaseVersion, current, gateParamsOf(thresholds)),
      waived: history !== undefined || current === releaseVersion,
    };
  });
  return {
    members: await membersOf(releaseVersion, settings),
    gate: {
      passes: gate.passed || waived,
      runs: gate.countedRuns,
      orgs: gate.orgs,
      failureRate: gate.failureRate,
      defaultFailureRate: gate.baselineFailureRate,
      thresholds: { n: gate.params.minRuns, m: gate.params.minOrgs, t: gate.params.maxFailurePointsAboveDefault },
      totalRuns: gate.totalRuns,
      perOrgCap: gate.perOrgCap,
      shortfalls: gate.shortfalls,
      waived,
      baselineReleaseVersion: gate.baselineReleaseVersion,
    },
  };
}

export interface RolloutUpdate {
  members: CanaryMember[];
  added: string[];
  removed: string[];
  /** Added orgs that were in ANOTHER release's canary (one canary per org): moved here. */
  moved: Array<{ orgId: string; fromReleaseVersion: string }>;
}

function refusal(code: ErrorCode, message: string, details?: Record<string, unknown>): AppError {
  return new AppError(getStatusForErrorCode(code), code, message, details);
}

function audit(actor: ToolchainActor, action: 'toolchain.rollout.update' | 'toolchain.release.notes' | 'toolchain.recovery.notify', details: Record<string, unknown>, outcome: 'success' | 'failure' = 'success'): void {
  recordAudit({
    action,
    actorId: actor,
    orgId: SYSTEM_ORG_ID,
    targetType: 'toolchain-release',
    targetId: typeof details.releaseVersion === 'string' ? details.releaseVersion : undefined,
    outcome,
    details,
  });
}

/**
 * `PUT /plugins/toolchain/releases/:v/rollout` — REPLACE the release's canary
 * set. An org is in at most one canary (`toolchain_rollout` is keyed by org),
 * so adding an org that is in another release's canary MOVES it, and the move
 * is reported. A non-empty set needs the release to pass the §8 pair, scan and
 * metadata guards (the guards a canary is served under), and the release must
 * not be the platform default. Serialized with promotions (the same advisory
 * lock), audited `toolchain.rollout.update`, and newly added orgs are told.
 */
export async function replaceRollout(releaseVersion: string, orgIdsIn: readonly string[], actor: ToolchainActor): Promise<RolloutUpdate> {
  const orgIds = [...new Set(orgIdsIn.map((id) => lower(id.trim())).filter((id) => id.length > 0))];
  if (orgIds.some((id) => id === lower(SYSTEM_ORG_ID))) throw new ValidationError('The system org is not a canary member');
  try {
    const out = await elevated(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('toolchain_platform_default'))`);
      const halves = await loadReleaseHalves(tx, releaseVersion);
      if (!halves.release && !halves.bootstrap && !halves.synth) throw new NotFoundError(`Toolchain release ${releaseVersion} not found`);
      if (orgIds.length > 0) {
        const problems = toolchainCandidateProblems(halves);
        if (problems.length > 0) {
          throw refusal(problems[0]!, `Release ${releaseVersion} can't be canaried: it fails ${problems.join(', ')}. A canary is served only while the release passes the pair, scan and metadata guards.`, { releaseVersion, problems });
        }
        if ((await readPlatformDefaultRelease(tx)) === releaseVersion) {
          throw new ConflictError(`Release ${releaseVersion} is the platform default; a canary of it has no effect.`, ErrorCode.CONFLICT, { releaseVersion });
        }
      }
      const current = (await tx.select({ orgId: schema.toolchainRollout.orgId }).from(schema.toolchainRollout)
        .where(eq(schema.toolchainRollout.releaseVersion, releaseVersion))).map((r) => lower(r.orgId));
      const elsewhere = orgIds.length === 0 ? [] : await tx.select({ orgId: schema.toolchainRollout.orgId, releaseVersion: schema.toolchainRollout.releaseVersion })
        .from(schema.toolchainRollout)
        .where(and(inArray(sql<string>`lower(${schema.toolchainRollout.orgId})`, orgIds), ne(schema.toolchainRollout.releaseVersion, releaseVersion)));
      const removed = current.filter((id) => !orgIds.includes(id));
      const added = orgIds.filter((id) => !current.includes(id));
      if (removed.length > 0) {
        await tx.delete(schema.toolchainRollout).where(and(
          eq(schema.toolchainRollout.releaseVersion, releaseVersion),
          inArray(sql<string>`lower(${schema.toolchainRollout.orgId})`, removed),
        ));
      }
      // A moved org's row may be stored in another case: drop it, then insert ours.
      if (elsewhere.length > 0) {
        await tx.delete(schema.toolchainRollout).where(inArray(schema.toolchainRollout.orgId, elsewhere.map((r) => r.orgId)));
      }
      const now = new Date();
      if (added.length > 0) {
        await tx.insert(schema.toolchainRollout).values(added.map((orgId) => ({ orgId, releaseVersion, addedBy: actor, addedAt: now })));
      }
      return {
        added,
        removed,
        moved: elsewhere.map((r) => ({ orgId: lower(r.orgId), fromReleaseVersion: r.releaseVersion })),
        settings: await readOrgSettings(tx),
      };
    });
    if (out.added.length > 0 || out.removed.length > 0) {
      audit(actor, 'toolchain.rollout.update', { releaseVersion, added: out.added, removed: out.removed, moved: out.moved });
    }
    const members = await membersOf(releaseVersion, out.settings);
    if (out.added.length > 0) {
      const has = new Map(members.map((m) => [m.orgId, m.hasOrgDefault]));
      void announceToolchain({ kind: 'canary', releaseVersion, orgs: out.added.map((orgId) => ({ orgId, hasOrgDefault: has.get(orgId) === true })) });
    }
    return { members, added: out.added, removed: out.removed, moved: out.moved };
  } catch (err) {
    if (err instanceof AppError) audit(actor, 'toolchain.rollout.update', { releaseVersion, refusal: err.code }, 'failure');
    throw err;
  }
}

// -----------------------------------------------------------------------------
// Promotion: preview (blast radius + guards) and set
// -----------------------------------------------------------------------------

export interface BlastRadius {
  /** Unpinned pipelines in orgs that follow the platform default: they move on their next run. */
  followingPipelines: number;
  /** Orgs with at least one such pipeline. */
  followingOrgs: number;
  /** Orgs whose own (or inherited) org default keeps them where they are. */
  orgsWithOwnDefault: number;
  /** Live pipelines pinning a release (`toolchain.release`): they don't move. */
  pinnedPipelines: number;
}

export interface DefaultPreview {
  blastRadius: BlastRadius;
  guards: Array<{ code: string; ok: boolean; detail?: string }>;
  currentDefault: string | null;
}

async function orgPicture(): Promise<{ pipelines: Map<string, { unpinned: number; pinned: number }>; cls: Map<string, OrgClassification> }> {
  const { pipelines, settings } = await elevated(async (tx) => ({ pipelines: await pipelinesByOrg(tx), settings: await readOrgSettings(tx) }));
  const cls = await classifyOrgs([...pipelines.keys(), ...settings.defaults.keys()], settings);
  return { pipelines, cls };
}

/**
 * `GET /plugins/toolchain/releases/:v/default-preview` — what "Set as platform
 * default" would do and whether it would be allowed, without writing: the §8
 * blast radius and every guard as `setPlatformDefault` judges it. Orgs in a
 * canary of ANOTHER release stay on it, so they are neither following nor
 * "own default".
 */
export async function previewDefault(releaseVersion: string, thresholds?: Partial<CanaryThresholds>): Promise<DefaultPreview> {
  await elevated((tx) => requireKnownRelease(tx, releaseVersion));
  const [{ currentDefault, guards }, { pipelines, cls }] = await Promise.all([
    previewPlatformDefaultGuards(releaseVersion, gateParamsOf(thresholds)),
    orgPicture(),
  ]);
  const blastRadius: BlastRadius = { followingPipelines: 0, followingOrgs: 0, orgsWithOwnDefault: 0, pinnedPipelines: 0 };
  for (const [orgId, c] of cls) {
    const p = pipelines.get(orgId) ?? { unpinned: 0, pinned: 0 };
    blastRadius.pinnedPipelines += p.pinned;
    if (c.via === 'org-default') {blastRadius.orgsWithOwnDefault += 1;} else if (c.via === 'default' && p.unpinned > 0) {
      blastRadius.followingOrgs += 1;
      blastRadius.followingPipelines += p.unpinned;
    }
  }
  return {
    blastRadius,
    guards: guards.map((g) => ({ code: g.code, ok: g.ok, ...(g.detail ? { detail: g.detail } : {}) })),
    currentDefault,
  };
}

/**
 * Tell orgs about a promotion (§10): orgs that follow the platform default get
 * "updating to X"; orgs with their own default get "a newer platform toolchain
 * is available". Canary members of other releases stay on them and aren't told.
 * Best-effort, after COMMIT.
 */
export async function announcePromotion(releaseVersion: string): Promise<{ followingOrgs: number; ownDefaultOrgs: number }> {
  try {
    const { pipelines, cls } = await orgPicture();
    const followingOrgIds: string[] = [];
    const ownDefaults: Array<{ orgId: string; releaseVersion: string }> = [];
    for (const [orgId, c] of cls) {
      if (c.via === 'default' && (pipelines.get(orgId)?.unpinned ?? 0) > 0) followingOrgIds.push(orgId);
      else if (c.via === 'org-default' && c.releaseVersion) ownDefaults.push({ orgId, releaseVersion: c.releaseVersion });
    }
    await announceToolchain({ kind: 'promoted', releaseVersion, followingOrgIds, ownDefaults });
    return { followingOrgs: followingOrgIds.length, ownDefaultOrgs: ownDefaults.filter((d) => d.releaseVersion !== releaseVersion).length };
  } catch (err) {
    logger.warn('Toolchain promotion announcement failed', { releaseVersion, error: errorMessage(err) });
    return { followingOrgs: 0, ownDefaultOrgs: 0 };
  }
}

/**
 * `POST /plugins/toolchain/releases/:v/default` — "Set as platform default"
 * (`setPlatformDefault`, kind `set`): every §8 guard, `expectedCurrentDefault`
 * concurrency, the canary gate (or a written override). Refusals pass through
 * with their codes and details. A change is announced (§10).
 */
export async function promoteRelease(releaseVersion: string, input: {
  expectedCurrentDefault: string | null;
  overrideReason?: string;
  canaryGate?: Partial<CanaryThresholds>;
}, actor: ToolchainActor): Promise<{ platformDefault: string; changed: boolean }> {
  const params = gateParamsOf(input.canaryGate);
  const result = await setPlatformDefault({
    releaseVersion,
    kind: 'set',
    actor,
    expectedCurrentDefault: input.expectedCurrentDefault,
    ...(input.overrideReason ? { overrideReason: input.overrideReason } : {}),
    ...(params ? { canaryGate: params } : {}),
  });
  if (result.changed) void announcePromotion(result.releaseVersion);
  return { platformDefault: result.releaseVersion, changed: result.changed };
}

// -----------------------------------------------------------------------------
// Release notes + lifecycle
// -----------------------------------------------------------------------------

/** `PATCH /plugins/toolchain/releases/:v` — edit the release notes (an empty string clears them). */
export async function setReleaseNotes(releaseVersion: string, releaseNotes: string, actor: ToolchainActor): Promise<{ releaseVersion: string; releaseNotes: string | null }> {
  const notes = releaseNotes.trim() === '' ? null : releaseNotes.trim();
  const [row] = await elevated((tx) => tx.update(schema.toolchainRelease).set({ releaseNotes: notes })
    .where(eq(schema.toolchainRelease.releaseVersion, releaseVersion))
    .returning({ releaseVersion: schema.toolchainRelease.releaseVersion, releaseNotes: schema.toolchainRelease.releaseNotes }));
  if (!row) {
    audit(actor, 'toolchain.release.notes', { releaseVersion, refusal: ErrorCode.NOT_FOUND }, 'failure');
    throw new NotFoundError(`Toolchain release ${releaseVersion} not found`);
  }
  audit(actor, 'toolchain.release.notes', { releaseVersion, length: notes?.length ?? 0 });
  return { releaseVersion: row.releaseVersion, releaseNotes: row.releaseNotes ?? null };
}

export async function deprecateConsoleRelease(releaseVersion: string, actor: ToolchainActor, message?: string | null): Promise<void> {
  await deprecateRelease({ releaseVersion, actor, message: message?.trim() ? message.trim() : null });
}

export async function yankConsoleRelease(releaseVersion: string, reason: string, actor: ToolchainActor): Promise<{ restoredDefault: string | null }> {
  const out = await yankRelease({ releaseVersion, actor, reason });
  return { restoredDefault: out.restored?.releaseVersion ?? null };
}

export async function deleteConsoleRelease(releaseVersion: string, actor: ToolchainActor): Promise<void> {
  await deleteRelease({ releaseVersion, actor });
}

// -----------------------------------------------------------------------------
// History, Affected, Cleanup
// -----------------------------------------------------------------------------

export interface DefaultHistoryEntry {
  releaseVersion: string;
  previousReleaseVersion: string | null;
  kind: string;
  setBy: string;
  setAt: string;
  reason: string | null;
}

/** `GET /plugins/toolchain/history` — `toolchain_default_history`, newest first. */
export async function getDefaultHistory(limit = 200): Promise<{ history: DefaultHistoryEntry[] }> {
  const rows = await elevated((tx) => tx.select().from(schema.toolchainDefaultHistory)
    .orderBy(desc(schema.toolchainDefaultHistory.setAt), desc(schema.toolchainDefaultHistory.id))
    .limit(limit));
  return {
    history: rows.map((r) => ({
      releaseVersion: r.releaseVersion,
      previousReleaseVersion: r.previousReleaseVersion ?? null,
      kind: r.kind,
      setBy: r.setBy,
      setAt: r.setAt.toISOString(),
      reason: r.reason ?? null,
    })),
  };
}

export interface AffectedView {
  releaseVersion: string;
  orgs: Array<{ orgId: string; orgName: string; pipelineCount: number; pipelineIds: string[] }>;
}

/** `GET /plugins/toolchain/affected?release=` — §9: pipelines on the release whose latest synth failed, by org. */
export async function getAffected(releaseVersion: string): Promise<AffectedView> {
  const affected = await elevated((tx) => readAffectedPipelines(tx, releaseVersion));
  const name = await namesFor(affected.orgs.map((o) => o.orgId));
  return {
    releaseVersion,
    orgs: affected.orgs.map((o) => ({ orgId: o.orgId, orgName: name(o.orgId), pipelineCount: o.pipelines, pipelineIds: o.pipelineIds })),
  };
}

/**
 * `POST /plugins/toolchain/affected/notify` — §9 "Notify affected owners": each
 * affected org's pipeline writers get `pipeline-manager pipeline deploy --id
 * <id>` for its own pipelines only. Audited `toolchain.recovery.notify` with
 * what was reached.
 */
export async function notifyAffected(releaseVersion: string, actor: ToolchainActor): Promise<{ notifiedOrgs: number; notifiedPipelines: number }> {
  const { affected, names } = await elevated(async (tx) => {
    const a = await readAffectedPipelines(tx, releaseVersion);
    const ids = a.orgs.flatMap((o) => o.pipelineIds);
    const rows = ids.length === 0 ? [] : await tx.select({ id: schema.pipeline.id, name: schema.pipeline.pipelineName })
      .from(schema.pipeline).where(inArray(sql<string>`${schema.pipeline.id}::text`, ids));
    return { affected: a, names: new Map(rows.map((r) => [String(r.id), r.name ?? null])) };
  });
  const orgs = affected.orgs.map((o) => ({
    orgId: o.orgId,
    pipelines: o.pipelineIds.map((id): RecoveryPipeline => ({ id, name: names.get(id) ?? null })),
  }));
  const sent = orgs.length === 0 ? { orgs: 0, pipelines: 0 } : await announceToolchain({ kind: 'recovery', releaseVersion, orgs });
  audit(actor, 'toolchain.recovery.notify', {
    releaseVersion,
    affectedOrgs: affected.orgs.length,
    affectedPipelines: affected.totalPipelines,
    notifiedOrgs: sent.orgs,
    notifiedPipelines: sent.pipelines,
  });
  return { notifiedOrgs: sent.orgs, notifiedPipelines: sent.pipelines };
}

/**
 * `GET /plugins/toolchain/cleanup` — releases nothing references (no deployed
 * manifest or declared resolution of either half, pipeline pin, org default,
 * canary, nor the platform default) that are OLDER than the last
 * {@link CLEANUP_KEEP_DEFAULTS} distinct platform defaults. With fewer defaults
 * than that, nothing is a candidate. Delete's own in-use check still applies.
 */
export async function getCleanupCandidates(): Promise<{ candidates: Array<{ releaseVersion: string; createdAt: string | null }> }> {
  return elevated(async (tx) => {
    const [releases, halves, referenced, recent] = await Promise.all([
      tx.select({ releaseVersion: schema.toolchainRelease.releaseVersion, createdAt: schema.toolchainRelease.createdAt }).from(schema.toolchainRelease),
      executeRows<{ version: string; created_at: Date | string }>(tx, sql`
        SELECT version, min(created_at) AS created_at FROM plugins
         WHERE lower(org_id) = ${lower(SYSTEM_ORG_ID)} AND name IN (${MANAGED_NAMES_SQL}) AND deleted_at IS NULL GROUP BY 1`),
      executeRows<{ v: string }>(tx, sql`
        SELECT plugin_version AS v FROM pipeline_step_manifests WHERE plugin_name IN (${MANAGED_NAMES_SQL}) AND plugin_publisher IS NULL
        UNION SELECT r.resolved_version FROM pipeline_plugin_resolution r JOIN pipelines lp ON lp.id::text = r.pipeline_id AND lp.deleted_at IS NULL
               WHERE r.plugin_name IN (${MANAGED_NAMES_SQL}) AND r.plugin_publisher IS NULL AND r.resolved_version IS NOT NULL
        UNION SELECT props->'toolchain'->>'release' FROM pipelines WHERE deleted_at IS NULL AND props->'toolchain'->>'release' IS NOT NULL
        UNION SELECT release_version FROM org_toolchain_default
        UNION SELECT release_version FROM toolchain_rollout
        UNION SELECT release_version FROM toolchain_platform_default`),
      executeRows<{ v: string }>(tx, sql`
        SELECT release_version AS v FROM toolchain_default_history GROUP BY 1 ORDER BY max(set_at) DESC LIMIT ${CLEANUP_KEEP_DEFAULTS}`),
    ]);
    if (recent.length < CLEANUP_KEEP_DEFAULTS) return { candidates: [] };
    const floor = recent.map((r) => r.v).sort(compareSemver)[0]!;
    const used = new Set(referenced.map((r) => r.v));
    const created = new Map<string, Date | null>();
    for (const h of halves) created.set(h.version, h.created_at ? new Date(h.created_at) : null);
    for (const r of releases) created.set(r.releaseVersion, r.createdAt);
    const candidates = [...created.entries()]
      .filter(([v]) => compareSemver(v, floor) < 0 && !used.has(v))
      .sort(([a], [b]) => compareSemver(a, b))
      .map(([releaseVersion, at]) => ({ releaseVersion, createdAt: at ? at.toISOString() : null }));
    return { candidates };
  });
}
