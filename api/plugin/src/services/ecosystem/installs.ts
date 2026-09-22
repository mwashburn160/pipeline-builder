// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Installs and the org consumption policy (docs/plans/plugin-ecosystem.md §3.2,
 * §3.4, §3.5, §5a, §5b, §5c, D11, D13, D16, G33).
 *
 *  - An org INSTALLS a listing (`plugins:install`). When its consumption
 *    policy requires approval for the listing's tier and the caller can't
 *    approve (`plugin_installs:manage`), the install is a PENDING request the
 *    org's approvers decide (N11 / N12). Everything here is ORG-LOCAL: it
 *    decides only what this org's pipelines may use (D13), never the ecosystem.
 *  - Official listings are installed implicitly (D16): no rows; an explicit
 *    install overrides the implicit one.
 *  - A team inherits its root org's installs and policy; its own installs stay
 *    team-local, and its own policy can only narrow the root's (G33).
 *
 * Resolution itself (which version a reference runs) is the shared resolver
 * in pipeline-data; this module applies it for the plugin service's routes.
 */

import {
  actorId,
  ConflictError,
  ErrorCode,
  getStatusForErrorCode,
  type Permission,
} from '@pipeline-builder/api-core';
import {
  advisoriesCovering,
  applyPolicyUpdate,
  blockingAdvisories,
  compareSemver,
  effectiveConsumptionPolicy,
  installAdmits,
  listedPluginRecord,
  listedVersionWarnings,
  listingBlock,
  loadOrgInstallContext,
  OFFICIAL_PUBLISHER_HANDLE,
  orgListingStates,
  parseSemver,
  policyOf,
  resolveListingReference,
  scopeOrgIds,
  INSTALL_VERSION_POLICIES,
  type ConsumptionPolicy,
  type InstallVersionPolicy,
  type ListingResolved,
  type OrgListingState,
  type PluginAdvisory,
  type PluginInstall,
  type PluginListing,
  type PluginListingVersion,
  type Publisher,
  type ResolutionRefusal,
  type ResolutionScope,
} from '@pipeline-builder/pipeline-data';

import { can, EcosystemError, type Caller } from './context.js';
import { orgApprovers } from './install-notify.js';
import { installRows, listingSource, ownPluginsNamed, policyRows } from './installs-store.js';
import { vulnDelta } from './policy.js';
import { RegistryPublicationError, verifyPublication } from './registry.js';
import { listingStats } from './reviews-store.js';
import { ImageVerificationError } from '../../helpers/supply-chain.js';
import { emitPluginAudit } from '../audit.js';
import { enqueueEcosystemNotification } from '../ecosystem-notifications.js';

const iso = (d: Date | string | null | undefined): string | null => (d ? new Date(d).toISOString() : null);

/** The resolution scope of a caller: its org, and (for a team) the root org. */
export function scopeOf(caller: Pick<Caller, 'orgId' | 'parentOrgId'>): ResolutionScope {
  return { orgId: caller.orgId, ...(caller.parentOrgId ? { rootOrgId: caller.parentOrgId } : {}) };
}

// -----------------------------------------------------------------------------
// Refusals
// -----------------------------------------------------------------------------

/** The ErrorCode of a resolver refusal. */
function codeOf(refusal: Pick<ResolutionRefusal, 'code'>): ErrorCode {
  return ErrorCode[refusal.code];
}

/** Throw a resolver refusal as an {@link EcosystemError} (its `reason` in `details`). */
export function refuse(refusal: ResolutionRefusal): never {
  throw new EcosystemError(codeOf(refusal), refusal.message, { reason: refusal.reason, ...(refusal.details ?? {}) });
}

// -----------------------------------------------------------------------------
// Views
// -----------------------------------------------------------------------------

/** Why an org can't use a listing right now (policy, state, or an advisory on every candidate). */
export interface BlockedInfo { reason: 'tier' | 'blocked_listing' | 'advisory' | 'suspended'; message: string }

function blockedOf(state: OrgListingState): BlockedInfo | null {
  if (state.block) return { reason: state.block.reason, message: state.block.message };
  if (state.refusal?.reason === 'advisory') return { reason: 'advisory', message: state.refusal.message };
  return null;
}

const isLive = (v: PluginListingVersion) => !v.yankedAt;
const isStable = (v: string) => (parseSemver(v)?.prerelease.length ?? 1) === 0;

/** The newest live stable version OUTSIDE the org's install range (an upgrade), with its changelog and vuln delta. */
function upgradeOf(state: OrgListingState) {
  if ('code' in state.mode) return null;
  const mode = state.mode;
  const current = state.resolved;
  const candidates = state.versions.filter((v) => isLive(v) && !v.pausedAt && isStable(v.version)
    && (!current || compareSemver(v.version, current.version) > 0)
    && (mode.kind === 'explicit' ? !installAdmits(mode.install, v.version, state.versions) : true)
    && v.id !== current?.id);
  const next = candidates.reduce<PluginListingVersion | null>((best, v) => (best === null || compareSemver(v.version, best.version) > 0 ? v : best), null);
  if (!next) return null;
  const crossed = state.versions.some((v) => v.breaking && (!current || compareSemver(v.version, current.version) > 0) && compareSemver(v.version, next.version) <= 0);
  return {
    version: next.version,
    breaking: crossed || (!!current && parseSemver(next.version)?.major !== parseSemver(current.version)?.major),
    changelog: next.changelog,
    vulnDelta: vulnDelta(current ? { critical: current.vulnCritical, high: current.vulnHigh } : null, { critical: next.vulnCritical, high: next.vulnHigh }),
  };
}

/** The API view of an install — explicit (any status) or implicit (virtual, `id: null`). */
export function installView(state: OrgListingState, ownOrgId: string) {
  const { publisher, listing } = state;
  const explicit = !('code' in state.mode) && state.mode.kind === 'explicit' ? state.mode : null;
  const row: PluginInstall | null = explicit?.install ?? state.ownInstall;
  const implicit = !row && !('code' in state.mode) && state.mode.kind === 'implicit';
  return {
    id: row?.id ?? null,
    listingId: listing.id,
    publisherHandle: publisher.handle,
    publisherDisplayName: publisher.displayName,
    publisherTier: publisher.tier,
    name: listing.name,
    summary: listing.summary,
    category: listing.category,
    icon: listing.icon ?? null,
    state: listing.state,
    paused: listing.pausedAt !== null,
    versionPolicy: (row?.versionPolicy ?? 'minor') as InstallVersionPolicy,
    pinnedVersion: row?.pinnedVersion ?? null,
    resolvedVersion: state.resolved?.version ?? null,
    latestVersion: listing.latestVersion,
    status: row?.status ?? 'active',
    implicit,
    inherited: !!row && row.orgId.toLowerCase() !== ownOrgId.toLowerCase(),
    installedBy: row?.installedBy ?? null,
    approvedBy: row?.approvedBy ?? null,
    createdAt: iso(row?.createdAt),
    decidedAt: iso(row?.decidedAt),
    upgrade: upgradeOf(state),
    blocked: blockedOf(state),
    ...installNotes(state),
  };
}
export type InstallView = ReturnType<typeof installView>;

/**
 * What an install's resolved version carries (W8): the lookup warnings
 * (advisory, deprecation, unmaintained, withheld secrets) and the PUBLISHED
 * advisories covering it — or, when an advisory BLOCKS resolution, the
 * blocking ones on the newest version the install would otherwise take.
 */
function installNotes(state: OrgListingState) {
  const brief = (a: Pick<PluginAdvisory, 'id' | 'severity' | 'summary' | 'fixedVersion'>, blocking: boolean) =>
    ({ id: a.id, severity: a.severity, summary: a.summary, fixedVersion: a.fixedVersion, blocking });
  if (state.resolved) {
    const { warnings } = listedVersionWarnings({ publisher: state.publisher, listing: state.listing, version: state.resolved, advisories: state.advisories, policy: state.policy });
    const advisories = advisoriesCovering(state.advisories, state.resolved.version).map((a) => brief(a, false));
    return { warnings, advisories };
  }
  if (state.refusal?.reason === 'advisory') {
    const ids = new Set(((state.refusal.details?.advisories as string[] | undefined) ?? []));
    return { warnings: [], advisories: state.advisories.filter((a) => ids.has(a.id)).map((a) => brief(a, true)) };
  }
  return { warnings: [], advisories: [] };
}

function listingSummary(publisher: Publisher, listing: PluginListing) {
  return {
    id: listing.id,
    publisherHandle: publisher.handle,
    publisherDisplayName: publisher.displayName,
    publisherTier: publisher.tier,
    name: listing.name,
    summary: listing.summary,
    category: listing.category,
    icon: listing.icon ?? null,
    latestVersion: listing.latestVersion,
    state: listing.state,
    paused: listing.pausedAt !== null,
    license: listing.license,
  };
}

function resolvedInfo(v: PluginListingVersion | null, listing: PluginListing) {
  if (!v) return null;
  const s = (v.specSnapshot ?? {}) as Record<string, unknown>;
  const strings = (x: unknown): string[] => (Array.isArray(x) ? x.map((e) => (typeof e === 'string' ? e : (e as { name?: string })?.name)).filter((e): e is string => typeof e === 'string') : []);
  return {
    version: v.version,
    pluginType: typeof s.pluginType === 'string' ? s.pluginType : null,
    computeType: typeof s.computeType === 'string' ? s.computeType : null,
    primaryOutputDirectory: typeof s.primaryOutputDirectory === 'string' ? s.primaryOutputDirectory : null,
    description: typeof s.description === 'string' ? s.description : listing.description,
    requiredMetadata: strings(s.requiredMetadata),
    requiredVars: strings(s.requiredVars),
    secrets: strings(s.secrets),
  };
}

/** Whether installing would create a pending request for this caller. */
function needsApproval(caller: Caller, policy: ConsumptionPolicy, tier: Publisher['tier']): boolean {
  return policy.requireApprovalTiers.includes(tier) && !can(caller, 'plugin_installs:manage');
}

/** The catalog entry for one listing: the listing, the org's standing, and the reference to write. */
function catalogEntry(caller: Caller, state: OrgListingState, policy: ConsumptionPolicy, shadowIds: string[]) {
  const install = !('code' in state.mode) || state.ownInstall ? installView(state, caller.orgId) : null;
  const blocked = blockedOf(state);
  const official = state.publisher.handle === OFFICIAL_PUBLISHER_HANDLE;
  const hasOwnRow = !!state.ownInstall;
  const shadowed = official && shadowIds.length > 0;
  return {
    listing: listingSummary(state.publisher, state.listing),
    install,
    installable: !blocked && state.listing.pausedAt === null && !hasOwnRow && can(caller, 'plugins:install'),
    requiresApproval: needsApproval(caller, policy, state.publisher.tier),
    blocked,
    resolved: resolvedInfo(state.resolved, state.listing),
    reference: official && !shadowed ? { name: state.listing.name } : { publisher: state.publisher.handle, name: state.listing.name },
    shadowedBy: shadowed ? { pluginIds: shadowIds } : null,
  };
}
export type CatalogEntry = ReturnType<typeof catalogEntry>;

interface ListingStatsSummary {
  rating: { score: number; count: number } | null;
  installCount: number;
  /** 0–100 health score (W7), null until the sweep has enough data. */
  healthScore: number | null;
}

/** Each listing's public rating, install count and health score (plugin_stats, W4/W7), for the in-app catalog. */
async function statsFor(listingIds: string[]): Promise<Map<string, ListingStatsSummary>> {
  const rows = await listingStats.byListings(listingIds);
  return new Map(rows.map((s) => [s.listingId, {
    rating: s.ratingCount > 0 && s.ratingBayes !== null ? { score: Math.round(s.ratingBayes * 100) / 100, count: s.ratingCount } : null,
    installCount: s.installCount,
    healthScore: s.healthScore === null || s.healthScore === undefined ? null : Math.round(s.healthScore),
  }]));
}
const NO_STATS: ListingStatsSummary = { rating: null, installCount: 0, healthScore: null };

// -----------------------------------------------------------------------------
// Reads
// -----------------------------------------------------------------------------

/** Own-org plugin ids that shadow each Official listing name (unqualified refs resolve them first). */
async function shadowMap(caller: Caller, names: string[]): Promise<Map<string, string[]>> {
  const rows = await ownPluginsNamed([...new Set(names)], { orgId: caller.orgId, parentOrgId: caller.parentOrgId, userId: caller.userId });
  const map = new Map<string, string[]>();
  for (const r of rows) map.set(r.name, [...(map.get(r.name) ?? []), r.id]);
  return map;
}

/** GET /plugins/catalog — every live listing with the org's standing (max 200). */
export async function catalog(caller: Caller, query: Record<string, unknown>) {
  const scope = scopeOf(caller);
  const ctx = await loadOrgInstallContext(listingSource, scope);
  const q = typeof query.q === 'string' ? query.q.trim().toLowerCase() : '';
  const category = typeof query.category === 'string' && query.category ? query.category : null;
  const installed = query.installed === 'true' ? true : query.installed === 'false' ? false : null;
  let states = await orgListingStates(listingSource, scope, {}, ctx);
  states = states.filter((s) => (!category || s.listing.category === category)
    && (!q || s.listing.name.includes(q) || (s.listing.summary ?? '').toLowerCase().includes(q)
      || s.publisher.handle.includes(q) || (s.listing.keywords ?? []).some((k) => k.toLowerCase().includes(q)))
    && (installed === null || (!('code' in s.mode)) === installed));
  states.sort((a, b) => a.listing.name.localeCompare(b.listing.name) || a.publisher.handle.localeCompare(b.publisher.handle));
  states = states.slice(0, 200);
  const shadows = await shadowMap(caller, states.filter((s) => s.publisher.handle === OFFICIAL_PUBLISHER_HANDLE).map((s) => s.listing.name));
  const stats = await statsFor(states.map((s) => s.listing.id));
  return {
    listings: states.map((s) => ({
      ...catalogEntry(caller, s, ctx.policy, s.publisher.handle === OFFICIAL_PUBLISHER_HANDLE ? shadows.get(s.listing.name) ?? [] : []),
      ...(stats.get(s.listing.id) ?? NO_STATS),
    })),
  };
}

async function listingOr404(handle: string, name: string): Promise<{ publisher: Publisher; listing: PluginListing }> {
  const publisher = await listingSource.publisherByHandle(handle);
  const listing = publisher ? await listingSource.listingByName(publisher.id, name) : null;
  if (!publisher || !listing) throw new EcosystemError(ErrorCode.NOT_FOUND, `No listing ${handle}/${name}.`);
  return { publisher, listing };
}

/** GET /plugins/listings/:publisher/:name/install-state — one listing's standing for the org (the install buttons). */
export async function installState(caller: Caller, handle: string, name: string) {
  const { listing } = await listingOr404(handle, name);
  const scope = scopeOf(caller);
  const ctx = await loadOrgInstallContext(listingSource, scope);
  const [state] = await orgListingStates(listingSource, scope, { ids: [listing.id] }, ctx);
  if (!state) throw new EcosystemError(ErrorCode.NOT_FOUND, `${handle}/${name} is not in the directory.`);
  const shadows = state.publisher.handle === OFFICIAL_PUBLISHER_HANDLE ? (await shadowMap(caller, [name])).get(name) ?? [] : [];
  const stats = (await statsFor([listing.id])).get(listing.id) ?? NO_STATS;
  return {
    entry: { ...catalogEntry(caller, state, ctx.policy, shadows), ...stats },
    versions: [...state.versions].sort((a, b) => compareSemver(b.version, a.version)).map((v) => ({
      version: v.version,
      breaking: v.breaking,
      yanked: v.yankedAt !== null,
      paused: v.pausedAt !== null,
      deprecated: v.deprecatedAt !== null,
      publishedAt: iso(v.publishedAt)!,
      changelog: v.changelog,
      vulnCritical: v.vulnCritical,
      vulnHigh: v.vulnHigh,
    })),
    canInstall: can(caller, 'plugins:install'),
    canManage: can(caller, 'plugin_installs:manage'),
  };
}

/** GET /plugins/installs — the org's installs (and, with `implicit=true`, the virtual Official ones). */
export async function listInstalls(caller: Caller, query: Record<string, unknown>) {
  const scope = scopeOf(caller);
  const ctx = await loadOrgInstallContext(listingSource, scope);
  const includeImplicit = query.implicit === 'true';
  const status = typeof query.status === 'string' && query.status !== 'all' ? query.status : null;
  const ids = [...new Set(ctx.installs.map((i) => i.listingId))];
  const states = includeImplicit
    ? await orgListingStates(listingSource, scope, {}, ctx)
    : await orgListingStates(listingSource, scope, { ids }, ctx);
  const own = caller.orgId.toLowerCase();
  const views = states
    .filter((s) => ctx.installs.some((i) => i.listingId === s.listing.id && (i.orgId.toLowerCase() === own || i.status === 'active'))
      || (includeImplicit && !('code' in s.mode) && s.mode.kind === 'implicit'))
    .map((s) => installView(s, caller.orgId))
    .filter((v) => !status || v.status === status)
    .sort((a, b) => a.name.localeCompare(b.name) || a.publisherHandle.localeCompare(b.publisherHandle));
  return { installs: views, policy: ctx.policy };
}

/** GET /plugins/shadowing — own plugins whose names shadow an Official listing the org would otherwise resolve. */
export async function shadowing(caller: Caller) {
  const states = (await orgListingStates(listingSource, scopeOf(caller)))
    .filter((s) => s.publisher.handle === OFFICIAL_PUBLISHER_HANDLE && s.resolved !== null);
  const shadows = await shadowMap(caller, states.map((s) => s.listing.name));
  return {
    shadowing: states
      .filter((s) => shadows.has(s.listing.name))
      .map((s) => ({
        name: s.listing.name,
        pluginIds: shadows.get(s.listing.name)!,
        listing: { publisherHandle: s.publisher.handle, name: s.listing.name, publisherTier: s.publisher.tier },
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}

// -----------------------------------------------------------------------------
// Writes
// -----------------------------------------------------------------------------

const HANDLE_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const NAME_RE = /^[a-z0-9][a-z0-9._-]*$/;

function need(caller: Caller, permission: Permission): void {
  if (!can(caller, permission)) throw new EcosystemError(ErrorCode.INSUFFICIENT_PERMISSIONS, `This needs ${permission}.`);
}

function parsePolicy(v: unknown, fallback: InstallVersionPolicy): InstallVersionPolicy {
  if (v === undefined || v === null) return fallback;
  if (typeof v !== 'string' || !(INSTALL_VERSION_POLICIES as readonly string[]).includes(v)) {
    throw new EcosystemError(ErrorCode.VALIDATION_ERROR, `versionPolicy must be one of ${INSTALL_VERSION_POLICIES.join(', ')}`);
  }
  return v as InstallVersionPolicy;
}

function audit(caller: Caller, action: Parameters<typeof emitPluginAudit>[0]['action'], targetId: string, details: Record<string, unknown>): void {
  emitPluginAudit({
    action,
    actorId: actorId({ userId: caller.userId }),
    orgId: caller.orgId,
    affectedOrgId: caller.orgId,
    targetType: 'plugin-install',
    targetId,
    details,
  });
}

/** The baseline version for a new install / upgrade: the one named, else the newest usable stable one. */
function baselineVersion(
  ref: string, versions: PluginListingVersion[], requested: unknown, policy: ConsumptionPolicy,
  advisoriesBlock: (v: string) => boolean, allowPaused: string | null,
): PluginListingVersion {
  if (requested !== undefined && requested !== null) {
    if (typeof requested !== 'string' || !parseSemver(requested)) throw new EcosystemError(ErrorCode.VALIDATION_ERROR, 'version must be an exact semantic version');
    const v = versions.find((x) => x.version === requested);
    if (!v) throw new EcosystemError(ErrorCode.NOT_FOUND, `${ref} has no published version ${requested}.`);
    if (v.yankedAt) refuse({ code: 'PLUGIN_UNAVAILABLE', reason: 'yanked', message: `${ref}@${requested} is yanked.` });
    if (v.pausedAt && v.version !== allowPaused) refuse({ code: 'PLUGIN_UNAVAILABLE', reason: 'paused', message: `${ref}@${requested} is paused by its publisher.` });
    if (advisoriesBlock(v.version)) refuse({ code: 'PLUGIN_BLOCKED_BY_POLICY', reason: 'advisory', message: `${ref}@${requested} is blocked by your organization's advisory policy (${policy.blockOnAdvisory}).` });
    return v;
  }
  const usable = versions.filter((v) => !v.yankedAt && !v.pausedAt && isStable(v.version) && !advisoriesBlock(v.version));
  const best = usable.reduce<PluginListingVersion | null>((b, v) => (b === null || compareSemver(v.version, b.version) > 0 ? v : b), null);
  if (!best) refuse({ code: 'PLUGIN_UNAVAILABLE', reason: 'no_version', message: `${ref} has no version your organization can install.` });
  return best;
}

async function standing(caller: Caller, listing: PluginListing): Promise<{ state: OrgListingState; policy: ConsumptionPolicy }> {
  const scope = scopeOf(caller);
  const ctx = await loadOrgInstallContext(listingSource, scope);
  const [state] = await orgListingStates(listingSource, scope, { ids: [listing.id] }, ctx);
  if (!state) refuse({ code: 'PLUGIN_UNAVAILABLE', reason: 'suspended', message: `${listing.name} is not in the directory.` });
  return { state, policy: ctx.policy };
}

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === '23505';
}

/** POST /plugins/installs — install a listing, or request the install when the policy requires approval. */
export async function createInstall(caller: Caller, body: Record<string, unknown>) {
  need(caller, 'plugins:install');
  const handle = body.publisher;
  const name = body.name;
  if (typeof handle !== 'string' || !HANDLE_RE.test(handle) || typeof name !== 'string' || !NAME_RE.test(name)) {
    throw new EcosystemError(ErrorCode.VALIDATION_ERROR, 'publisher and name are required (a publisher handle and a plugin name)');
  }
  const versionPolicy = parsePolicy(body.versionPolicy, 'minor');
  const { publisher, listing } = await listingOr404(handle, name);
  const ref = `${handle}/${name}`;
  const { state, policy } = await standing(caller, listing);
  if (state.block) refuse({ code: state.block.reason === 'suspended' ? 'PLUGIN_UNAVAILABLE' : 'PLUGIN_BLOCKED_BY_POLICY', reason: state.block.reason, message: state.block.message });
  // A paused listing takes no new installs (§3.4, D14).
  if (listing.pausedAt) refuse({ code: 'PLUGIN_UNAVAILABLE', reason: 'paused', message: `${ref} is paused by its publisher and takes no new installs.` });

  const own = state.ownInstall;
  if (own?.status === 'active') throw new ConflictError(`${ref} is already installed.`, ErrorCode.DUPLICATE_ENTRY);
  if (own?.status === 'pending_approval') throw new ConflictError(`An install request for ${ref} is already waiting for approval.`, ErrorCode.DUPLICATE_ENTRY);

  const blocks = (v: string) => blockingAdvisories(state.advisories, v, policy).length > 0;
  const baseline = baselineVersion(ref, state.versions, body.version, policy, blocks, null);
  const pending = needsApproval(caller, policy, publisher.tier);
  const now = new Date();
  const values = {
    versionPolicy,
    pinnedVersion: baseline.version,
    resolvedVersion: null,
    status: pending ? 'pending_approval' as const : 'active' as const,
    installedBy: caller.userId,
    approvedBy: pending ? null : policy.requireApprovalTiers.includes(publisher.tier) ? caller.userId : null,
    decidedAt: pending ? null : now,
  };
  let row: PluginInstall;
  try {
    row = own
      ? (await installRows.transition(own.id, 'denied', values)) ?? (() => { throw new ConflictError(`${ref} changed; reload and retry.`, ErrorCode.DUPLICATE_ENTRY); })()
      : await installRows.insert({ ...values, orgId: caller.orgId, listingId: listing.id });
  } catch (err) {
    if (isUniqueViolation(err)) throw new ConflictError(`${ref} is already installed or requested.`, ErrorCode.DUPLICATE_ENTRY);
    throw err;
  }
  const details = { listing: ref, version: baseline.version, versionPolicy, tier: publisher.tier };
  if (pending) {
    audit(caller, 'plugin.install.request', row.id, details);
    await enqueueEcosystemNotification('N11', [orgApprovers(caller.orgId)], {
      subject: `Install requested: ${ref}`,
      text: `${caller.name ?? 'A member'} asked to install ${ref} ${baseline.version} (${publisher.tier}). Approve or deny it on the Plugins page → Approvals.`,
    }).catch(() => undefined);
  } else {
    audit(caller, 'plugin.install.create', row.id, details);
  }
  return { install: installView((await standing(caller, listing)).state, caller.orgId) };
}

async function ownRow(caller: Caller, id: string): Promise<PluginInstall> {
  const row = await installRows.byId(id);
  // Only the org's OWN rows: a team can't change or remove its root's install.
  if (!row || row.orgId.toLowerCase() !== caller.orgId.toLowerCase()) throw new EcosystemError(ErrorCode.NOT_FOUND, 'Install not found');
  return row;
}

async function listingOfRow(row: PluginInstall): Promise<{ publisher: Publisher; listing: PluginListing }> {
  const [listing] = await listingSource.liveListings({ ids: [row.listingId] });
  if (!listing) refuse({ code: 'PLUGIN_UNAVAILABLE', reason: 'suspended', message: 'The listing is no longer in the directory.' });
  const [publisher] = await listingSource.publishersByIds([listing.publisherId]);
  if (!publisher) throw new EcosystemError(ErrorCode.NOT_FOUND, 'Publisher not found');
  return { publisher, listing };
}

/**
 * PATCH /plugins/installs/:id — change the version policy or move the
 * baseline (an upgrade). Crossing a major or `breaking` version on a tier the
 * policy gates needs an approver (§3.2: majors never flow without re-approval).
 */
export async function updateInstall(caller: Caller, id: string, body: Record<string, unknown>) {
  need(caller, 'plugins:install');
  const row = await ownRow(caller, id);
  if (row.status !== 'active') throw new ConflictError(`This install is ${row.status}; only an active install can be upgraded.`);
  const { publisher, listing } = await listingOfRow(row);
  const ref = `${publisher.handle}/${listing.name}`;
  const { state, policy } = await standing(caller, listing);
  if (state.block) refuse({ code: state.block.reason === 'suspended' ? 'PLUGIN_UNAVAILABLE' : 'PLUGIN_BLOCKED_BY_POLICY', reason: state.block.reason, message: state.block.message });
  const versionPolicy = parsePolicy(body.versionPolicy, row.versionPolicy);
  const blocks = (v: string) => blockingAdvisories(state.advisories, v, policy).length > 0;
  const current = state.resolved?.version ?? row.resolvedVersion ?? row.pinnedVersion;
  const baseline = body.version === undefined ? state.versions.find((v) => v.version === row.pinnedVersion) ?? null : null;
  const target = baseline ?? baselineVersion(ref, state.versions, body.version, policy, blocks, current);

  const from = current ?? row.pinnedVersion;
  const crosses = !!from && compareSemver(target.version, from) > 0 && (
    parseSemver(target.version)?.major !== parseSemver(from)?.major
    || state.versions.some((v) => v.breaking && compareSemver(v.version, from) > 0 && compareSemver(v.version, target.version) <= 0));
  const widens = versionPolicy === 'latest' && row.versionPolicy !== 'latest';
  if ((crosses || widens) && policy.requireApprovalTiers.includes(publisher.tier) && !can(caller, 'plugin_installs:manage')) {
    throw new EcosystemError(ErrorCode.INSUFFICIENT_PERMISSIONS,
      `Moving ${ref} across a major or breaking version needs an approver (plugin_installs:manage) in your organization.`);
  }
  const updated = await installRows.update(row.id, { versionPolicy, pinnedVersion: target.version, resolvedVersion: null });
  if (!updated) throw new EcosystemError(ErrorCode.NOT_FOUND, 'Install not found');
  audit(caller, 'plugin.install.upgrade', row.id, {
    listing: ref,
    from: { versionPolicy: row.versionPolicy, version: row.pinnedVersion },
    to: { versionPolicy, version: target.version },
  });
  return { install: installView((await standing(caller, listing)).state, caller.orgId) };
}

/** DELETE /plugins/installs/:id — uninstall, or withdraw a pending request. */
export async function removeInstall(caller: Caller, id: string) {
  need(caller, 'plugins:install');
  const row = await ownRow(caller, id);
  // A member withdraws their own request; removing anyone else's needs plugins:install
  // (already held) — an active install is org state every holder may remove.
  if (!await installRows.remove(row.id)) throw new EcosystemError(ErrorCode.NOT_FOUND, 'Install not found');
  const [listing] = await listingSource.liveListings({ ids: [row.listingId] });
  const [publisher] = listing ? await listingSource.publishersByIds([listing.publisherId]) : [];
  const ref = publisher && listing ? `${publisher.handle}/${listing.name}` : row.listingId;
  audit(caller, 'plugin.install.remove', row.id, { listing: ref, status: row.status, ...(row.status === 'pending_approval' ? { withdrawn: true } : {}) });
  let implicitFallback = false;
  if (publisher?.handle === OFFICIAL_PUBLISHER_HANDLE && listing) {
    const scope = scopeOf(caller);
    const rows = await listingSource.policiesForOrgs(scopeOrgIds(scope));
    const policy = effectiveConsumptionPolicy(rows, scopeOrgIds(scope)[0]!, scopeOrgIds(scope)[1]);
    implicitFallback = policy.officialInstalls === 'implicit' && !listingBlock(policy, publisher, listing);
  }
  return { removed: true, implicitFallback };
}

async function decide(caller: Caller, id: string, approve: boolean, reason: string | null) {
  need(caller, 'plugin_installs:manage');
  const row = await ownRow(caller, id);
  if (row.status !== 'pending_approval') throw new ConflictError(`This install is ${row.status}, not waiting for approval.`);
  const { publisher, listing } = await listingOfRow(row);
  const ref = `${publisher.handle}/${listing.name}`;
  if (approve) {
    // Re-check the policy at decision time: it may have changed since the request.
    const { state } = await standing(caller, listing);
    if (state.block) refuse({ code: state.block.reason === 'suspended' ? 'PLUGIN_UNAVAILABLE' : 'PLUGIN_BLOCKED_BY_POLICY', reason: state.block.reason, message: state.block.message });
  }
  const decided = await installRows.transition(row.id, 'pending_approval', {
    status: approve ? 'active' : 'denied',
    approvedBy: approve ? caller.userId : null,
    decidedAt: new Date(),
  });
  if (!decided) throw new ConflictError('The request was decided by someone else.');
  audit(caller, approve ? 'plugin.install.approve' : 'plugin.install.deny', row.id, {
    listing: ref, requestedBy: row.installedBy, version: row.pinnedVersion, ...(reason ? { reason: reason.slice(0, 200) } : {}),
  });
  await enqueueEcosystemNotification('N12', [{ kind: 'user', userId: row.installedBy, orgId: caller.orgId }], {
    subject: `Install ${approve ? 'approved' : 'denied'}: ${ref}`,
    text: approve
      ? `Your request to install ${ref} ${row.pinnedVersion ?? ''} was approved. Pipelines can reference it now.`
      : `Your request to install ${ref} was denied${reason ? `: ${reason}` : '.'}`,
  }).catch(() => undefined);
  return { install: installView((await standing(caller, listing)).state, caller.orgId) };
}

/** POST /plugins/installs/:id/approve */
export function approveInstall(caller: Caller, id: string) {
  return decide(caller, id, true, null);
}

/** POST /plugins/installs/:id/deny */
export function denyInstall(caller: Caller, id: string, reason: unknown) {
  return decide(caller, id, false, typeof reason === 'string' && reason.trim() ? reason.trim().slice(0, 1000) : null);
}

// -----------------------------------------------------------------------------
// Consumption policy
// -----------------------------------------------------------------------------

/** GET /plugins/install-policy */
export async function getPolicy(caller: Caller) {
  const orgIds = scopeOrgIds(scopeOf(caller));
  const rows = await listingSource.policiesForOrgs(orgIds);
  const own = rows.find((r) => r.orgId.toLowerCase() === orgIds[0]) ?? null;
  return {
    policy: policyOf(own),
    effective: effectiveConsumptionPolicy(rows, orgIds[0]!, orgIds[1]),
    inheritsFromRoot: orgIds.length > 1,
    updatedBy: own?.updatedBy ?? null,
    updatedAt: iso(own?.updatedAt),
    canEdit: can(caller, 'plugin_installs:manage'),
  };
}

/** PUT /plugins/install-policy — org-local (D13), step-up at the route, audited. */
export async function putPolicy(caller: Caller, body: unknown) {
  need(caller, 'plugin_installs:manage');
  const before = policyOf(await policyRows.get(caller.orgId));
  const next = applyPolicyUpdate(before, body);
  if (typeof next === 'string') throw new EcosystemError(ErrorCode.VALIDATION_ERROR, next);
  await policyRows.put(caller.orgId, { ...next, updatedBy: caller.userId });
  const changed = (Object.keys(next) as Array<keyof ConsumptionPolicy>).filter((k) => JSON.stringify(next[k]) !== JSON.stringify(before[k]));
  emitPluginAudit({
    action: 'org.plugin-install-policy.update',
    actorId: actorId({ userId: caller.userId }),
    orgId: caller.orgId,
    affectedOrgId: caller.orgId,
    targetType: 'plugin-install-policy',
    targetId: caller.orgId,
    details: {
      changed,
      ...Object.fromEntries(changed.filter((k) => k !== 'blockedListings').map((k) => [k, { from: before[k], to: next[k] }])),
      ...(changed.includes('blockedListings') ? { blockedListings: next.blockedListings.length } : {}),
    },
  });
  return getPolicy(caller);
}

// -----------------------------------------------------------------------------
// Lookup (the listing half of `/plugins/lookup`)
// -----------------------------------------------------------------------------

/** A lookup resolved to a listed version: the run record plus what the route needs. */
export interface ListedLookup {
  resolution: ListingResolved;
  record: Record<string, unknown>;
}

/** A lookup the org's install or policy refuses, ready to answer. */
export interface RefusedLookup {
  refused: { status: number; code: ErrorCode; message: string; details: Record<string, unknown> };
}

/**
 * Resolve a reference to an installed listing for the caller. Null when no
 * such listing exists; the refusal (with its HTTP status) when the org can't
 * use it. Records what an explicit own-org install resolved to (paused
 * versions keep resolving for installs already on them, §3.4).
 */
export async function resolveListedLookup(
  scope: ResolutionScope,
  ref: { publisher?: string; name: string; version?: string },
): Promise<ListedLookup | RefusedLookup | null> {
  const res = await resolveListingReference(listingSource, ref, scope);
  if (!res) return null;
  if (!res.ok) {
    const code = codeOf(res.refusal);
    return { refused: { status: getStatusForErrorCode(code), code, message: res.refusal.message, details: { reason: res.refusal.reason, ...(res.refusal.details ?? {}) } } };
  }
  if (res.mode.kind === 'explicit' && !res.mode.inherited && res.mode.install.resolvedVersion !== res.version.version && ref.version === undefined) {
    await installRows.update(res.mode.install.id, { resolvedVersion: res.version.version }).catch(() => undefined);
  }
  return { resolution: res, record: listedPluginRecord(res) };
}

/** Whether an unqualified reference to `name` would reach an Official listing if the org's own plugin didn't shadow it. */
export async function shadowedListing(scope: ResolutionScope, name: string): Promise<{ publisher: string; name: string } | null> {
  const res = await resolveListingReference(listingSource, { name }, scope).catch(() => null);
  return res && res.ok ? { publisher: res.publisher.handle, name: res.listing.name } : null;
}

/**
 * Verify a listed version's `public/*` image before lookup hands out its
 * digest (§3.3, §8): the signature must verify AND its signed `pb.trust` /
 * `pb.publisher` annotations must match the publisher's CURRENT tier and
 * handle — a tier changed in the database without a re-sign, or an image
 * signed for someone else, is refused. Throws {@link ImageVerificationError};
 * a registry outage rethrows as is.
 */
export async function verifyListedImage(res: Pick<ListingResolved, 'publisher' | 'listing' | 'version'>): Promise<void> {
  const { publisher, listing, version } = res;
  const ref = `${publisher.handle}/${listing.name}@${version.version}`;
  if (!version.imageDigest || !version.imageRepository) {
    throw new ImageVerificationError(`Plugin ${ref} has no published image`);
  }
  let verdict;
  try {
    verdict = await verifyPublication(version.imageRepository, version.imageDigest);
  } catch (err) {
    if (err instanceof RegistryPublicationError && err.status >= 400 && err.status < 500) {
      throw new ImageVerificationError(`Plugin ${ref} image could not be verified: ${err.message}`);
    }
    throw err;
  }
  if (!verdict.signed) throw new ImageVerificationError(`Plugin ${ref} image ${version.imageDigest} has no valid platform signature`);
  if (verdict.tier !== publisher.tier || verdict.publisher !== publisher.handle) {
    throw new ImageVerificationError(
      `Plugin ${ref} image is signed as ${verdict.tier ?? 'unknown'}/${verdict.publisher ?? 'unknown'}, `
      + `not ${publisher.tier}/${publisher.handle}; it must be re-signed before it resolves`);
  }
}
