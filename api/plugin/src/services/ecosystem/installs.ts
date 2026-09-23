// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Installs and the org consumption policy (docs/plugin-publishing.md,
 *).
 *
 *  - An org INSTALLS a listing (`plugins:install`). When its consumption
 *    policy requires approval for the listing's tier and the caller can't
 *    approve (`plugin_installs:manage`), the install is a PENDING request the
 *    org's approvers decide (N11 / N12). Everything here is ORG-LOCAL: it
 *    decides only what this org's pipelines may use, never the ecosystem.
 *  - Official listings are installed implicitly: no rows; an explicit
 *    install overrides the implicit one.
 *  - A team inherits its root org's installs and policy; its own installs stay
 *    team-local, and its own policy can only narrow the root's.
 *
 * Resolution itself (which version a reference runs) is the shared resolver
 * in pipeline-data; this module applies it for the plugin service's routes.
 */

import { isoOrNull, actorId, ConflictError, ErrorCode, paginationMeta, type Permission, parsePage } from '@pipeline-builder/api-core';
import {
  isUniqueViolation,
  applyPolicyUpdate,
  blockingAdvisories,
  compareSemver,
  effectiveConsumptionPolicy,
  listingBlock,
  loadOrgInstallContext,
  OFFICIAL_PUBLISHER_HANDLE,
  orgListingStates,
  parseSemver,
  policyOf,
  scopeOrgIds,
  INSTALL_VERSION_POLICIES,
  type ConsumptionPolicy,
  type InstallChangeRequest,
  type InstallVersionPolicy,
  type OrgListingState,
  type PluginInstall,
  type PluginListing,
  type PluginListingVersion,
  type Publisher,
  type ResolutionRefusal,
  type ResolutionScope,
} from '@pipeline-builder/pipeline-data';

import { ecosystemAudit } from './audit.js';
import { can, EcosystemError, type Caller } from './context.js';
import { orgApprovers } from './install-notify.js';
import { installRows, listingSource, ownPluginsNamed, policyRows } from './installs-store.js';
import { catalogEntry, installView, isStable, needsApproval, NO_STATS, statsFor } from './installs-views.js';
import { sendNotice, userRecipient } from './notify.js';
import { optionalText } from './util.js';


/** The resolution scope of a caller: its org, and (for a team) the root org. */
export function scopeOf(caller: Pick<Caller, 'orgId' | 'parentOrgId'>): ResolutionScope {
  return { orgId: caller.orgId, ...(caller.parentOrgId ? { rootOrgId: caller.parentOrgId } : {}) };
}

// -----------------------------------------------------------------------------
// Refusals
// -----------------------------------------------------------------------------

/** The ErrorCode of a resolver refusal. */
export function codeOf(refusal: Pick<ResolutionRefusal, 'code'>): ErrorCode {
  return ErrorCode[refusal.code];
}

/** Throw a resolver refusal as an {@link EcosystemError} (its `reason` in `details`). */
export function refuse(refusal: ResolutionRefusal): never {
  throw new EcosystemError(codeOf(refusal), refusal.message, { reason: refusal.reason, ...(refusal.details ?? {}) });
}

/** Refuse when the org's policy (or a suspension) blocks the listing. */
function refuseBlocked(state: Pick<OrgListingState, 'block'>): void {
  if (!state.block) return;
  refuse({ code: state.block.reason === 'suspended' ? 'PLUGIN_UNAVAILABLE' : 'PLUGIN_BLOCKED_BY_POLICY', reason: state.block.reason, message: state.block.message });
}

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

/** Catalog page size: default and ceiling. */
const CATALOG_PAGE_DEFAULT = 200;
const CATALOG_PAGE_MAX = 200;

/**
 * GET /plugins/catalog — the live listings with the org's standing, one page
 * (`limit` ≤ 200, `offset`) of the filtered, name-sorted set, with the `total`
 * it was cut from and `hasMore`.
 */
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
  const { limit, offset } = parsePage(query, { def: CATALOG_PAGE_DEFAULT, max: CATALOG_PAGE_MAX });
  const total = states.length;
  states = states.slice(offset, offset + limit);
  const shadows = await shadowMap(caller, states.filter((s) => s.publisher.handle === OFFICIAL_PUBLISHER_HANDLE).map((s) => s.listing.name));
  const stats = await statsFor(states.map((s) => s.listing.id));
  return {
    listings: states.map((s) => ({
      ...catalogEntry(caller, s, ctx.policy, s.publisher.handle === OFFICIAL_PUBLISHER_HANDLE ? shadows.get(s.listing.name) ?? [] : []),
      ...(stats.get(s.listing.id) ?? NO_STATS),
    })),
    ...paginationMeta({ total, offset, limit, returned: states.length }),
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
      publishedAt: isoOrNull(v.publishedAt)!,
      changelog: v.changelog,
      vulnCritical: v.vulnCritical,
      vulnHigh: v.vulnHigh,
      vulnCriticalFixable: v.vulnCriticalFixable,
      vulnHighFixable: v.vulnHighFixable,
      scanFlaggedAt: isoOrNull(v.scanFlaggedAt),
      scanFlag: v.scanFlag,
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
    .map((s) => ({ ...installView(s, caller.orgId), needsApproval: needsApproval(caller, ctx.policy, s.publisher.tier) }))
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
  refuseBlocked(state);
  // A paused listing takes no new installs.
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
    ecosystemAudit({ action: 'plugin.install.request', actor: actorId({ userId: caller.userId }), orgId: caller.orgId, affectedOrgId: caller.orgId, targetType: 'plugin-install', targetId: row.id, details });
    await sendNotice('N11', [orgApprovers(caller.orgId)], {
      subject: `Install requested: ${ref}`,
      text: `${caller.name ?? 'A member'} asked to install ${ref} ${baseline.version} (${publisher.tier}). Approve or deny it on the Plugins page → Approvals.`,
    });
  } else {
    ecosystemAudit({ action: 'plugin.install.create', actor: actorId({ userId: caller.userId }), orgId: caller.orgId, affectedOrgId: caller.orgId, targetType: 'plugin-install', targetId: row.id, details });
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

/** What changing an active install to `body` means: the target, and whether it needs an approver. */
async function planInstallChange(caller: Caller, row: PluginInstall, body: Record<string, unknown>) {
  if (row.status !== 'active') throw new ConflictError(`This install is ${row.status}; only an active install can be upgraded.`);
  const { publisher, listing } = await listingOfRow(row);
  const ref = `${publisher.handle}/${listing.name}`;
  const { state, policy } = await standing(caller, listing);
  refuseBlocked(state);
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
  const gated = (crosses || widens) && policy.requireApprovalTiers.includes(publisher.tier);
  return { publisher, listing, ref, policy, versionPolicy, target, gated };
}

/** Apply a planned change and audit it as an upgrade. */
async function applyInstallChange(caller: Caller, row: PluginInstall, change: { versionPolicy: InstallVersionPolicy; version: string }, ref: string, extra: Record<string, unknown> = {}) {
  const updated = await installRows.update(row.id, { versionPolicy: change.versionPolicy, pinnedVersion: change.version, resolvedVersion: null, pendingChange: null });
  if (!updated) throw new EcosystemError(ErrorCode.NOT_FOUND, 'Install not found');
  ecosystemAudit({
    action: 'plugin.install.upgrade',
    actor: actorId({ userId: caller.userId }),
    orgId: caller.orgId,
    affectedOrgId: caller.orgId,
    targetType: 'plugin-install',
    targetId: row.id,
    details: {
      listing: ref,
      from: { versionPolicy: row.versionPolicy, version: row.pinnedVersion },
      to: { versionPolicy: change.versionPolicy, version: change.version },
      ...extra,
    },
  });
}

/**
 * PATCH /plugins/installs/:id — change the version policy or move the
 * baseline (an upgrade). Crossing a major or `breaking` version on a tier the
 * policy gates needs an approver (majors never flow without re-approval);
 * a member without one REQUESTS the change instead (POST …/change-requests).
 */
export async function updateInstall(caller: Caller, id: string, body: Record<string, unknown>) {
  need(caller, 'plugins:install');
  const row = await ownRow(caller, id);
  const plan = await planInstallChange(caller, row, body);
  if (plan.gated && !can(caller, 'plugin_installs:manage')) {
    throw new EcosystemError(ErrorCode.INSUFFICIENT_PERMISSIONS,
      `Moving ${plan.ref} across a major or breaking version needs an approver (plugin_installs:manage) in your organization; request the change instead.`,
      { requestable: true });
  }
  await applyInstallChange(caller, row, { versionPolicy: plan.versionPolicy, version: plan.target.version }, plan.ref);
  return { install: installView((await standing(caller, plan.listing)).state, caller.orgId), needsApproval: needsApproval(caller, plan.policy, plan.publisher.tier) };
}

/** A change request as the API shows it. */
function changeRequestView(row: PluginInstall, ref: string) {
  const c = row.pendingChange!;
  return { installId: row.id, listing: ref, from: { version: row.pinnedVersion, versionPolicy: row.versionPolicy }, to: { version: c.version, versionPolicy: c.versionPolicy }, requestedBy: c.requestedBy, requestedAt: c.requestedAt, note: c.note };
}

/**
 * POST /plugins/installs/:id/change-requests — a member asks for an install
 * change that needs an approver (the version / policy PATCH would refuse):
 * stored on the install as its ONE pending change, the org's approvers told
 * (N11). A change that needs no approval is refused here — PATCH it.
 */
export async function requestInstallChange(caller: Caller, id: string, body: Record<string, unknown>) {
  need(caller, 'plugins:install');
  const row = await ownRow(caller, id);
  if (row.pendingChange) throw new ConflictError('This install already has a change waiting for approval.', ErrorCode.DUPLICATE_ENTRY);
  const plan = await planInstallChange(caller, row, body);
  if (!plan.gated || can(caller, 'plugin_installs:manage')) {
    throw new EcosystemError(ErrorCode.VALIDATION_ERROR, `This change of ${plan.ref} needs no approval; apply it with PATCH /plugins/installs/${row.id}.`);
  }
  const note = optionalText(body.note, 1000);
  const pendingChange: InstallChangeRequest = {
    version: plan.target.version, versionPolicy: plan.versionPolicy, requestedBy: caller.userId, requestedAt: new Date().toISOString(), note,
  };
  // Guarded on status: a removal or a racing request can't be overwritten.
  const stored = await installRows.setPendingChange(row.id, pendingChange);
  if (!stored) throw new ConflictError(`${plan.ref} changed meanwhile; reload and retry.`, ErrorCode.DUPLICATE_ENTRY);
  ecosystemAudit({
    action: 'plugin.install.change-request',
    actor: actorId({ userId: caller.userId }),
    orgId: caller.orgId,
    affectedOrgId: caller.orgId,
    targetType: 'plugin-install',
    targetId: row.id,
    details: {
      listing: plan.ref, from: { versionPolicy: row.versionPolicy, version: row.pinnedVersion }, to: { versionPolicy: plan.versionPolicy, version: plan.target.version },
    },
  });
  await sendNotice('N11', [orgApprovers(caller.orgId)], {
    subject: `Install change requested: ${plan.ref}`,
    text: `${caller.name ?? 'A member'} asked to move ${plan.ref} from ${row.pinnedVersion ?? row.versionPolicy} to ${plan.target.version} (policy ${plan.versionPolicy})${note ? `: ${note}` : ''}. Approve or reject it on the Plugins page → Approvals.`,
  });
  return { changeRequest: changeRequestView(stored, plan.ref) };
}

/** GET /plugins/installs/change-requests — the org's pending install changes (approvers). */
export async function listInstallChangeRequests(caller: Caller) {
  need(caller, 'plugin_installs:manage');
  const rows = await installRows.withPendingChange(caller.orgId);
  const listingsById = new Map((await listingSource.liveListings({ ids: [...new Set(rows.map((r) => r.listingId))] })).map((l) => [l.id, l]));
  const pubs = new Map((await listingSource.publishersByIds([...new Set([...listingsById.values()].map((l) => l.publisherId))])).map((p) => [p.id, p]));
  return {
    changeRequests: rows.map((r) => {
      const l = listingsById.get(r.listingId);
      const p = l ? pubs.get(l.publisherId) : undefined;
      return changeRequestView(r, l && p ? `${p.handle}/${l.name}` : r.listingId);
    }).sort((a, b) => a.requestedAt.localeCompare(b.requestedAt)),
  };
}

/** A requester's notice (N12) about the decision on their request. */
interface DecisionNotice { requester: string; subject: string; text: string }

/**
 * The approver side of an install request or change request: gate on
 * `plugin_installs:manage`, load the org's row (refused by `precheck` when
 * there is nothing to decide) and its listing, act, tell the requester, and
 * answer with the fresh install view.
 */
async function decideOnRow(
  caller: Caller,
  id: string,
  precheck: (row: PluginInstall) => void,
  act: (row: PluginInstall, listing: PluginListing, ref: string) => Promise<DecisionNotice>,
) {
  need(caller, 'plugin_installs:manage');
  const row = await ownRow(caller, id);
  precheck(row);
  const { publisher, listing } = await listingOfRow(row);
  const ref = `${publisher.handle}/${listing.name}`;
  const notice = await act(row, listing, ref);
  await sendNotice('N12', [userRecipient(notice.requester, caller.orgId)], { subject: notice.subject, text: notice.text });
  return { install: installView((await standing(caller, listing)).state, caller.orgId) };
}

function decideChange(caller: Caller, id: string, approve: boolean, reason: string | null) {
  return decideOnRow(caller, id, (row) => {
    if (!row.pendingChange) throw new ConflictError('This install has no change waiting for approval.');
  }, async (row, _listing, ref) => {
    const change = row.pendingChange!;
    if (approve) {
    // Re-validated at decision time: the version may be yanked, paused or blocked by now.
      const plan = await planInstallChange(caller, row, { version: change.version, versionPolicy: change.versionPolicy });
      await applyInstallChange(caller, row, { versionPolicy: plan.versionPolicy, version: plan.target.version }, ref, { requestedBy: change.requestedBy });
      ecosystemAudit({ action: 'plugin.install.change-approve', actor: actorId({ userId: caller.userId }), orgId: caller.orgId, affectedOrgId: caller.orgId, targetType: 'plugin-install', targetId: row.id, details: { listing: ref, requestedBy: change.requestedBy, to: { versionPolicy: change.versionPolicy, version: change.version } } });
    } else {
      if (!await installRows.clearPendingChange(row.id)) throw new ConflictError('The change was decided by someone else.');
      ecosystemAudit({ action: 'plugin.install.change-reject', actor: actorId({ userId: caller.userId }), orgId: caller.orgId, affectedOrgId: caller.orgId, targetType: 'plugin-install', targetId: row.id, details: { listing: ref, requestedBy: change.requestedBy, ...(reason ? { reason: reason.slice(0, 200) } : {}) } });
    }
    return {
      requester: change.requestedBy,
      subject: `Install change ${approve ? 'approved' : 'rejected'}: ${ref}`,
      text: approve
        ? `Your request to move ${ref} to ${change.version} (policy ${change.versionPolicy}) was approved.`
        : `Your request to move ${ref} to ${change.version} was rejected${reason ? `: ${reason}` : '.'}`,
    };
  });
}

/** POST /plugins/installs/:id/change-requests/approve — apply the pending change. */
export function approveInstallChange(caller: Caller, id: string) {
  return decideChange(caller, id, true, null);
}

/** POST /plugins/installs/:id/change-requests/reject — drop it, telling the requester why. */
export function rejectInstallChange(caller: Caller, id: string, reason: unknown) {
  return decideChange(caller, id, false, optionalText(reason, 1000));
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
  ecosystemAudit({ action: 'plugin.install.remove', actor: actorId({ userId: caller.userId }), orgId: caller.orgId, affectedOrgId: caller.orgId, targetType: 'plugin-install', targetId: row.id, details: { listing: ref, status: row.status, ...(row.status === 'pending_approval' ? { withdrawn: true } : {}) } });
  let implicitFallback = false;
  if (publisher?.handle === OFFICIAL_PUBLISHER_HANDLE && listing) {
    const scope = scopeOf(caller);
    const rows = await listingSource.policiesForOrgs(scopeOrgIds(scope));
    const policy = effectiveConsumptionPolicy(rows, scopeOrgIds(scope)[0]!, scopeOrgIds(scope)[1]);
    implicitFallback = policy.officialInstalls === 'implicit' && !listingBlock(policy, publisher, listing);
  }
  return { removed: true, implicitFallback };
}

function decide(caller: Caller, id: string, approve: boolean, reason: string | null) {
  return decideOnRow(caller, id, (row) => {
    if (row.status !== 'pending_approval') throw new ConflictError(`This install is ${row.status}, not waiting for approval.`);
  }, async (row, listing, ref) => {
    if (approve) {
    // Re-check the policy at decision time: it may have changed since the request.
      const { state } = await standing(caller, listing);
      refuseBlocked(state);
    }
    const decided = await installRows.transition(row.id, 'pending_approval', {
      status: approve ? 'active' : 'denied',
      approvedBy: approve ? caller.userId : null,
      decidedAt: new Date(),
    });
    if (!decided) throw new ConflictError('The request was decided by someone else.');
    ecosystemAudit({
      action: approve ? 'plugin.install.approve' : 'plugin.install.deny',
      actor: actorId({ userId: caller.userId }),
      orgId: caller.orgId,
      affectedOrgId: caller.orgId,
      targetType: 'plugin-install',
      targetId: row.id,
      details: {
        listing: ref, requestedBy: row.installedBy, version: row.pinnedVersion, ...(reason ? { reason: reason.slice(0, 200) } : {}),
      },
    });
    return {
      requester: row.installedBy,
      subject: `Install ${approve ? 'approved' : 'denied'}: ${ref}`,
      text: approve
        ? `Your request to install ${ref} ${row.pinnedVersion ?? ''} was approved. Pipelines can reference it now.`
        : `Your request to install ${ref} was denied${reason ? `: ${reason}` : '.'}`,
    };
  });
}

/** POST /plugins/installs/:id/approve */
export function approveInstall(caller: Caller, id: string) {
  return decide(caller, id, true, null);
}

/** POST /plugins/installs/:id/deny */
export function denyInstall(caller: Caller, id: string, reason: unknown) {
  return decide(caller, id, false, optionalText(reason, 1000));
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
    updatedAt: isoOrNull(own?.updatedAt),
    canEdit: can(caller, 'plugin_installs:manage'),
  };
}

/** PUT /plugins/install-policy — org-local, step-up at the route, audited. */
export async function putPolicy(caller: Caller, body: unknown) {
  need(caller, 'plugin_installs:manage');
  const before = policyOf(await policyRows.get(caller.orgId));
  const next = applyPolicyUpdate(before, body);
  if (typeof next === 'string') throw new EcosystemError(ErrorCode.VALIDATION_ERROR, next);
  await policyRows.put(caller.orgId, { ...next, updatedBy: caller.userId });
  const changed = (Object.keys(next) as Array<keyof ConsumptionPolicy>).filter((k) => JSON.stringify(next[k]) !== JSON.stringify(before[k]));
  ecosystemAudit({
    action: 'org.plugin-install-policy.update',
    actor: actorId({ userId: caller.userId }),
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
