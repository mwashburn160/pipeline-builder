// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Deciding publish requests (docs/plans/plugin-ecosystem.md §3.0–§3.4):
 *
 *  - separation of duties (§3.0.1): no manager decides a request from an org
 *    they belong to, the uploader never approves their own Official version,
 *    and the two approvals of a two-person decision come from two identities;
 *  - two-person approval: the first approval parks the request in
 *    `pending_second_approval` (N28), the second executes it;
 *  - execution per kind — approval of a new listing / version publishes the
 *    PINNED digest into `public/<publisher>/<name>` with a fresh tier-annotated
 *    signature (§3.3) and records the frozen version (§3.4);
 *  - automatic decisions: the one-time BOOTSTRAP exception for the initial
 *    Official catalog (§3.1) and the system-org auto-approval rules (§3.0.3).
 *
 * Every decision claims the request with an optimistic status transition
 * BEFORE executing, so two managers can never both execute one request; a
 * failed execution rolls the status back.
 */

import {
  emitCounter,
  actorId,
  ConflictError,
  createLogger,
  ErrorCode,
  errorMessage,
  fetchOrgMembership,
  isOfficialAutoApprovalEnabled,
  isSystemOrgId,
  SYSTEM_ACTOR_ID,
  SYSTEM_ORG_ID,
} from '@pipeline-builder/api-core';
import { Config, pluginImageRepository } from '@pipeline-builder/pipeline-core';
import {
  OFFICIAL_PUBLISHER_HANDLE,
  type EcosystemAutoApprovalRule,
  type PluginListing,
  type PluginListingVersion,
  type PluginPublishRequest,
  type Publisher,
  type PublishRequestStatus,
} from '@pipeline-builder/pipeline-data';

import { discardDraft, publishAdvisory } from './advisories.js';
import { can, EcosystemError, isOfficialLoader, type Caller } from './context.js';
import { announceNewVersion } from './install-notify.js';
import { effectiveMetadata, listingColumns, type RequestMetadata } from './metadata.js';
import {
  notifyDecision, notifyModerationAction, notifySecondApprovalNeeded, notifyTransferUpdate, requestTitle,
} from './notify.js';
import {
  contractDiff, evaluateAutoRule, latestVersion, needsTwoPerson, requiredDecisionPermission, specSnapshot, versionBump, vulnDelta,
  type AutoApprovalContext, type AutoRuleConditions,
} from './policy.js';
import { handleRefusal, listingsQuota } from './publishers.js';
import { invalidateVerifyCache, publishImage, retagImage, yankImage } from './registry.js';
import { enqueueResign, trustFor } from './resign.js';
import {
  ACTIVE_LISTING_STATES, listings, OPEN_STATUSES, plugins, publishers, requests, rules, settings, versions, type PluginRow,
} from './store.js';
import { assertVerifiedEligible, checkVerifiedEligibility } from './verified-eligibility.js';
import { resolveBaseImageCreatedAt } from '../../helpers/base-image.js';
import type { RegistryInfo } from '../../helpers/registry-auth.js';
import { emitPluginAudit } from '../audit.js';

const logger = createLogger('ecosystem-decisions');

/** The anonymous-submission side (W5), loaded on first use: the decision graph never needs it otherwise. */
const submissionModeration = () => import('./submission-moderation.js');

type Req = PluginPublishRequest;
const payloadOf = (r: Req) => (r.payload ?? {}) as Record<string, unknown>;

// -----------------------------------------------------------------------------
// Separation of duties (§3.0.1)
// -----------------------------------------------------------------------------

export interface Conflict { conflict: boolean; reason: string | null }
const NO_CONFLICT: Conflict = { conflict: false, reason: null };

/** Membership probe (platform), overridable in tests. */
let membershipProbe: (orgId: string, userId: string) => Promise<boolean | undefined> = (orgId, userId) => {
  const { services } = Config.get('server');
  return fetchOrgMembership(orgId, userId, {
    service: { host: services.platformHost, port: services.platformPort, timeout: 5_000 },
    serviceName: 'plugin',
    authOrgId: SYSTEM_ORG_ID,
  });
};

/** Test hook: replace the platform membership probe. */
export function setMembershipProbeForTests(fn: typeof membershipProbe): void {
  membershipProbe = fn;
}

/**
 * The base image `created` time recorded on a listed version (W7 freshness).
 * Best effort: null on any failure, never blocks a publish. Overridable in tests.
 */
let baseImageProbe: (plugin: PluginRow) => Promise<Date | null> = async (plugin) => {
  if (!plugin.imageDigest) return null;
  try {
    return await resolveBaseImageCreatedAt({
      orgId: plugin.orgId,
      name: plugin.name,
      imageDigest: plugin.imageDigest,
      imageSource: plugin.imageSource ?? null,
      dockerfile: plugin.dockerfile ?? null,
    }, Config.get('registry') as RegistryInfo);
  } catch {
    return null;
  }
};

/** Test hook: replace the base-image age probe. */
export function setBaseImageProbeForTests(fn: typeof baseImageProbe): void {
  baseImageProbe = fn;
}

/** The orgs whose members may not decide `r`: the requesting org, the publisher's org, and a transfer's receiving org. */
function interestedOrgs(r: Req, publisher: Pick<Publisher, 'ownerOrgId'> | null): string[] {
  const orgs = new Set<string>();
  if (r.submittedOrgId) orgs.add(r.submittedOrgId.toLowerCase());
  if (publisher?.ownerOrgId) orgs.add(publisher.ownerOrgId.toLowerCase());
  const target = (payloadOf(r).transfer as { targetOrgId?: string } | undefined)?.targetOrgId;
  if (target) orgs.add(target.toLowerCase());
  // Every manager is a member of the system org; for the Official catalog the
  // rule is "not the uploader" instead (checked separately).
  orgs.delete(SYSTEM_ORG_ID);
  return [...orgs];
}

/**
 * Whether `moderator` may decide `r` (§3.0.1). `deep` adds the membership
 * probes (one per interested org); the queue list passes a shared cache so a
 * page of requests costs one probe per distinct org. An indeterminate probe
 * FAILS CLOSED.
 */
export async function conflictOfInterest(
  moderator: Caller,
  r: Req,
  publisher: Pick<Publisher, 'ownerOrgId'> | null,
  opts: { deep?: boolean; cache?: Map<string, boolean | undefined>; plugin?: PluginRow | null } = {},
): Promise<Conflict> {
  if (r.submittedBy === moderator.userId) return { conflict: true, reason: 'You submitted this request.' };
  if (r.status === 'pending_second_approval' && r.firstApprovedBy === moderator.userId) {
    return { conflict: true, reason: 'You gave the first approval; a different manager must give the second.' };
  }
  if (opts.plugin && opts.plugin.createdBy === moderator.userId) {
    return { conflict: true, reason: 'You uploaded this version.' };
  }
  if (!opts.deep) return NO_CONFLICT;
  for (const orgId of interestedOrgs(r, publisher)) {
    const key = `${orgId}:${moderator.userId}`;
    let member = opts.cache?.get(key);
    if (!opts.cache?.has(key)) {
      member = await membershipProbe(orgId, moderator.userId).catch(() => undefined);
      opts.cache?.set(key, member);
    }
    if (member === undefined) return { conflict: true, reason: 'Your membership of the requesting organization could not be verified.' };
    if (member) return { conflict: true, reason: 'You belong to the requesting organization.' };
  }
  return NO_CONFLICT;
}

// -----------------------------------------------------------------------------
// Bootstrap exception (§3.1)
// -----------------------------------------------------------------------------

export const BOOTSTRAP_KEY = 'bootstrap';

export interface BootstrapState {
  openedAt: string | null;
  closedAt: string | null;
  reason: string | null;
  approved: number;
}

/** How long the bootstrap window stays open once the first Official request rides it. */
export function bootstrapWindowMs(): number {
  const h = Number.parseInt(process.env.ECOSYSTEM_BOOTSTRAP_WINDOW_HOURS ?? '24', 10);
  return (Number.isFinite(h) && h > 0 ? h : 24) * 3_600_000;
}

export async function bootstrapState(): Promise<BootstrapState> {
  return (await settings.get<BootstrapState>(BOOTSTRAP_KEY)) ?? { openedAt: null, closedAt: null, reason: null, approved: 0 };
}

/** Close the bootstrap exception for good (idempotent). */
export async function closeBootstrap(reason: string, by: string): Promise<void> {
  const state = await bootstrapState();
  if (state.closedAt) return;
  await settings.put(BOOTSTRAP_KEY, { ...state, closedAt: new Date().toISOString(), reason }, by);
  logger.info('Ecosystem bootstrap exception closed', { reason });
}

/**
 * Whether `r` rides the bootstrap exception: an Official request from the
 * catalog loader while the instance has no listings of its own making. The
 * window OPENS on the first such request of an empty instance and stays open
 * for the initial load (`ECOSYSTEM_BOOTSTRAP_WINDOW_HOURS`, default 24) —
 * builds finish in parallel, so "zero listings" is judged when the load
 * starts, not per plugin. It closes for good when the window elapses, when any
 * manager decides a request, or when the instance already had listings.
 */
async function bootstrapEligible(r: Req, publisher: Publisher, submitter: Caller): Promise<boolean> {
  if (publisher.handle !== OFFICIAL_PUBLISHER_HANDLE || !isOfficialLoader(submitter)) return false;
  if (!['new_listing', 'new_version', 'listing_update'].includes(r.kind)) return false;
  const state = await bootstrapState();
  if (state.closedAt) return false;
  if (!state.openedAt) {
    if ((await listings.countAll()) > 0) {
      await closeBootstrap('listings_exist', SYSTEM_ACTOR_ID);
      return false;
    }
    await settings.put(BOOTSTRAP_KEY, { ...state, openedAt: new Date().toISOString() }, SYSTEM_ACTOR_ID);
    return true;
  }
  if (Date.now() - new Date(state.openedAt).getTime() > bootstrapWindowMs()) {
    await closeBootstrap('window_elapsed', SYSTEM_ACTOR_ID);
    return false;
  }
  return true;
}

// -----------------------------------------------------------------------------
// Auto-approval rules (§3.0.3)
// -----------------------------------------------------------------------------

/** The previous APPROVED (listed, not yanked) version of a listing, excluding `except`. */
export async function previousVersion(listingId: string | null, except: string | null): Promise<PluginListingVersion | null> {
  if (!listingId) return null;
  const rows = (await versions.forListings([listingId])).filter((v) => v.version !== except && !v.yankedAt);
  const latest = latestVersion(rows.map((v) => v.version));
  return rows.find((v) => v.version === latest) ?? null;
}

/** Whether the rule's instance flag is on (a rule without one always is). */
export function ruleFlagOn(conditions: AutoRuleConditions): boolean {
  return conditions.instanceFlag === 'OFFICIAL_AUTO_APPROVAL_ENABLED' ? isOfficialAutoApprovalEnabled() : true;
}

/** Everything but the rate counters a rule decides on (shared with the review view). */
export async function autoApprovalFacts(r: Req, publisher: Publisher, listing: PluginListing | null, plugin: PluginRow | null): Promise<Omit<AutoApprovalContext, 'approvedToday' | 'approvedTodayForListing' | 'flagOn'>> {
  const submitter = payloadOf(r).submitter as { principalType?: string; name?: string } | undefined;
  const loader = submitter?.principalType === 'service_account' && r.submittedOrgId && isSystemOrgId(r.submittedOrgId) ? submitter.name ?? null : null;
  const base = {
    kind: r.kind,
    publisherTier: publisher.tier,
    submitterServiceAccount: loader,
    listingLive: !!listing && (ACTIVE_LISTING_STATES as readonly string[]).includes(listing.state),
    securityLane: r.lane === 'security',
  };
  if (r.kind === 'new_version' && plugin) {
    const prev = await previousVersion(listing?.id ?? null, r.version);
    const hasImage = plugin.imageDigest !== null;
    return {
      ...base,
      bump: versionBump(prev?.version ?? null, plugin.version),
      breaking: payloadOf(r).breaking === true || plugin.breaking === true,
      diff: contractDiff(prev?.specSnapshot ?? null, specSnapshot(plugin)),
      vuln: vulnDelta(prev ? { critical: prev.vulnCritical, high: prev.vulnHigh } : null, { critical: plugin.vulnCritical, high: plugin.vulnHigh }),
      signed: hasImage || plugin.buildType === 'metadata_only',
      scanned: !hasImage || plugin.scannedAt !== null,
    };
  }
  if (r.kind === 'listing_update') {
    return { ...base, changedFields: Object.keys(((payloadOf(r).metadata as RequestMetadata | undefined)?.values) ?? {}) };
  }
  return base;
}

/** Evaluate one rule for `r` (rate counters included). */
export async function evaluateRuleFor(rule: EcosystemAutoApprovalRule, r: Req, facts: Awaited<ReturnType<typeof autoApprovalFacts>>): Promise<{ eligible: boolean; reasons: string[] }> {
  const conditions = (rule.conditions ?? {}) as AutoRuleConditions;
  const since = new Date(Date.now() - 24 * 3_600_000);
  // The caps count approvals of the SAME kind ("1 auto-approved VERSION per
  // listing per day"): a text-only listing update never eats a version's slot.
  const today = (conditions.maxPerDay !== undefined || conditions.maxPerListingPerDay !== undefined)
    ? (await requests.autoApprovedSince(rule.id, since)).filter((t) => t.kind === r.kind) : [];
  return evaluateAutoRule(conditions, {
    ...facts,
    approvedToday: today.length,
    approvedTodayForListing: today.filter((t) => t.listingId !== null && t.listingId === r.listingId).length,
    flagOn: ruleFlagOn(conditions),
  });
}

/** The first ENABLED rule that approves `r`, and why each rule declined. */
export async function matchingRule(r: Req, publisher: Publisher, listing: PluginListing | null, plugin: PluginRow | null): Promise<{ rule: EcosystemAutoApprovalRule | null; reasons: string[] }> {
  if (r.kind !== 'new_version' && r.kind !== 'listing_update') return { rule: null, reasons: [`${r.kind} requests are never auto-approved`] };
  const facts = await autoApprovalFacts(r, publisher, listing, plugin);
  const reasons: string[] = [];
  for (const rule of (await rules.list()).filter((x) => x.enabled)) {
    const verdict = await evaluateRuleFor(rule, r, facts);
    if (verdict.eligible) return { rule, reasons: [] };
    reasons.push(...verdict.reasons.map((why) => `${rule.name}: ${why}`));
  }
  return { rule: null, reasons: reasons.length ? reasons : ['no auto-approval rule is enabled'] };
}

/**
 * Right after a request is submitted: approve it automatically when the
 * bootstrap exception or an auto-approval rule covers it. Returns the decided
 * request, or null when it waits for a person. Never throws for a refused
 * EXECUTION: the request then stays pending for a manager.
 */
export async function autoDecide(r: Req, publisher: Publisher, submitter: Caller): Promise<Req | null> {
  const bootstrap = await bootstrapEligible(r, publisher, submitter);
  let rule: EcosystemAutoApprovalRule | null = null;
  if (!bootstrap) {
    const listing = r.listingId ? await listings.byId(r.listingId) : null;
    const plugin = r.pluginId ? await plugins.byId(r.pluginId) : null;
    rule = (await matchingRule(r, publisher, listing, plugin)).rule;
    if (!rule) return null;
  }
  const claimed = await requests.transition(r.id, 'pending', {
    status: 'approved',
    decidedBy: SYSTEM_ACTOR_ID,
    decidedAt: new Date(),
    autoRuleId: rule?.id ?? null,
    payload: bootstrap ? { ...payloadOf(r), bootstrap: true } : payloadOf(r),
  });
  if (!claimed) return null;
  try {
    await execute(claimed, publisher, SYSTEM_ACTOR_ID, { human: false });
  } catch (err) {
    await requests.transition(r.id, 'approved', { status: 'pending', decidedBy: null, decidedAt: null, autoRuleId: null, payload: payloadOf(r) });
    logger.warn('Automatic approval could not execute; left for a manager', { requestId: r.id, error: errorMessage(err) });
    emitCounter('ecosystem_auto_approval_failed_total', { kind: r.kind });
    return null;
  }
  if (bootstrap) {
    const state = await bootstrapState();
    await settings.put(BOOTSTRAP_KEY, { ...state, approved: state.approved + 1 }, SYSTEM_ACTOR_ID);
  }
  emitCounter('ecosystem_auto_approvals_total', { kind: r.kind, rule: bootstrap ? 'bootstrap' : rule!.name });
  emitPluginAudit({
    action: 'plugin.request.auto-approve',
    actorId: SYSTEM_ACTOR_ID,
    orgId: SYSTEM_ORG_ID,
    ...(publisher.ownerOrgId ? { affectedOrgId: publisher.ownerOrgId } : {}),
    targetType: 'plugin-publish-request',
    targetId: r.id,
    details: {
      kind: r.kind,
      ...(bootstrap ? { bootstrap: true } : { autoRuleId: rule!.id, rule: rule!.name }),
      ...(r.version ? { version: r.version } : {}),
      ...(r.digest ? { digest: r.digest } : {}),
    },
  });
  await notifyDecision({ kind: r.kind, title: await titleOf(claimed, publisher), publisherOrgId: publisher.ownerOrgId, approved: true, auto: true });
  return claimed;
}

// -----------------------------------------------------------------------------
// Execution per kind
// -----------------------------------------------------------------------------

async function titleOf(r: Req, publisher: Pick<Publisher, 'handle'>): Promise<string> {
  const listing = r.listingId ? await listings.byId(r.listingId) : null;
  return requestTitle({ kind: r.kind, handle: publisher.handle, name: listing?.name ?? (payloadOf(r).name as string | undefined) ?? null, version: r.version });
}

function audit(action: Parameters<typeof emitPluginAudit>[0]['action'], actor: string, publisher: Pick<Publisher, 'ownerOrgId'>, targetType: string, targetId: string, details: Record<string, unknown>): void {
  emitPluginAudit({
    action,
    actorId: actor,
    orgId: SYSTEM_ORG_ID,
    ...(publisher.ownerOrgId ? { affectedOrgId: publisher.ownerOrgId } : {}),
    targetType,
    targetId,
    details,
  });
}

/** Refuse (and record) a request that exceeds the `listings` quota at APPROVAL (§3.7). */
async function rejectForQuota(r: Req, publisher: Publisher, actor: string, used: number, limit: number): Promise<never> {
  // The request was claimed as approved; record the quota refusal instead.
  await requests.transition(r.id, 'approved', { status: 'rejected', reason: 'listings_quota', decidedBy: actor, decidedAt: new Date() });
  audit('plugin.request.reject', actor, publisher, 'plugin-publish-request', r.id, { kind: r.kind, reason: 'listings_quota', used, limit });
  throw new EcosystemError(ErrorCode.QUOTA_EXCEEDED, `The publisher is at its listings limit (${used}/${limit}); the request was rejected.`, { quotaType: 'listings', used, limit, rejected: true });
}

/** The plugin row a version request pinned, checked against the pin (G25: fail closed). */
async function pinnedPlugin(r: Req, publisher: Publisher): Promise<PluginRow> {
  const plugin = r.pluginId ? await plugins.byId(r.pluginId, publisher.ownerOrgId ?? undefined) : null;
  if (!plugin) throw new EcosystemError(ErrorCode.NOT_FOUND, 'The requested plugin version no longer exists.');
  if ((plugin.imageDigest ?? null) !== (r.digest ?? null) || plugin.version !== r.version) {
    throw new ConflictError('The plugin version no longer matches the digest the request pinned.', ErrorCode.PLUGIN_DIGEST_MISMATCH);
  }
  return plugin;
}

/** Publish a pinned version into `public/*` and record it on the listing (new_listing / new_version). */
async function publishVersion(r: Req, publisher: Publisher, actor: string): Promise<void> {
  const plugin = await pinnedPlugin(r, publisher);
  const payload = payloadOf(r);
  const metadata = (payload.metadata as RequestMetadata | undefined) ?? effectiveMetadata(plugin);
  let listing = r.listingId ? await listings.byId(r.listingId) : await listings.byName(publisher.id, plugin.name);

  if (r.kind === 'new_listing') {
    if (listing) throw new ConflictError(`${publisher.handle} already has a listing named ${plugin.name}.`);
    if (publisher.ownerOrgId && publisher.ownerOrgId !== SYSTEM_ORG_ID) {
      const quota = await listingsQuota(publisher.ownerOrgId, publisher.id);
      if (quota.limit !== -1 && quota.used >= quota.limit) await rejectForQuota(r, publisher, actor, quota.used, quota.limit);
    }
  } else {
    if (!listing || !(ACTIVE_LISTING_STATES as readonly string[]).includes(listing.state)) {
      throw new ConflictError('The listing is not live (suspended or transferred); the version cannot be published.');
    }
    if (await versions.get(listing.id, plugin.version)) throw new ConflictError(`${plugin.version} is already published to this listing.`);
    if (r.lane !== 'security' && publisher.ownerOrgId && publisher.ownerOrgId !== SYSTEM_ORG_ID) {
      const quota = await listingsQuota(publisher.ownerOrgId, publisher.id);
      if (quota.limit !== -1 && quota.used > quota.limit) await rejectForQuota(r, publisher, actor, quota.used, quota.limit);
    }
  }

  let imageRepository: string | null = null;
  if (plugin.imageDigest) {
    const published = await publishImage({
      sourceRepository: pluginImageRepository(plugin)!,
      digest: plugin.imageDigest,
      publisherHandle: publisher.handle,
      name: plugin.name,
      version: plugin.version,
      tier: trustFor(publisher),
      publisherOrgId: publisher.ownerOrgId,
    });
    imageRepository = published.imageRepository;
  }
  const baseImageCreatedAt = await baseImageProbe(plugin);

  if (!listing) {
    listing = await listings.insert({
      publisherId: publisher.id,
      name: plugin.name,
      ...listingColumns(metadata.values),
      latestVersion: plugin.version,
    });
  }
  const version = await versions.insert({
    listingId: listing.id,
    sourcePluginId: plugin.id,
    version: plugin.version,
    imageDigest: plugin.imageDigest,
    imageRepository,
    specSnapshot: specSnapshot(plugin),
    breaking: payload.breaking === true || plugin.breaking === true,
    changelog: plugin.changelog,
    vulnCritical: plugin.vulnCritical,
    vulnHigh: plugin.vulnHigh,
    scannedAt: plugin.scannedAt,
    baseImageCreatedAt,
    publishedBy: actor,
  });
  const live = (await versions.forListings([listing.id])).filter((v) => !v.yankedAt).map((v) => v.version);
  const updated = await listings.update(listing.id, { latestVersion: latestVersion(live) });
  if (!r.listingId) await requests.transition(r.id, 'approved', { listingId: listing.id });
  audit('plugin.listing.publish', actor, publisher, 'plugin-listing-version', version.id, {
    listing: `${publisher.handle}/${plugin.name}`, version: plugin.version, digest: plugin.imageDigest, tier: publisher.tier, kind: r.kind,
  });
  // N27 / N13 to the installing orgs (a brand-new listing has none yet).
  if (r.kind === 'new_version') await announceNewVersion(publisher, updated ?? listing, version);
}

/** Yank a listed version (system org): stop it resolving, drop the public tag, tell the publisher (N8). */
export async function yankListedVersion(listing: PluginListing, publisher: Publisher, version: string, reason: string, actor: string): Promise<PluginListingVersion> {
  const v = await versions.get(listing.id, version);
  if (!v) throw new EcosystemError(ErrorCode.NOT_FOUND, 'Version not found');
  if (v.yankedAt) throw new ConflictError(`${version} is already yanked.`);
  // Resolution reads listing versions (plan §3.5), so the yank stops new
  // synths resolving it for every installer at once.
  const yanked = (await versions.update(v.id, { yankedAt: new Date(), yankReason: reason }))!;
  if (v.imageRepository && v.imageDigest) {
    await yankImage({ imageRepository: v.imageRepository, version, digest: v.imageDigest }).catch((err) => {
      emitCounter('ecosystem_registry_yank_failed_total', {});
      logger.warn('public/* tag removal failed (the version is yanked in the catalog regardless)', { version, error: errorMessage(err) });
    });
    await invalidateVerifyCache({ imageRepository: v.imageRepository, digest: v.imageDigest }).catch(() => undefined);
  }
  const live = (await versions.forListings([listing.id])).filter((x) => !x.yankedAt && x.id !== v.id).map((x) => x.version);
  await listings.update(listing.id, { latestVersion: latestVersion(live) });
  audit('plugin.version.yank', actor, publisher, 'plugin-listing-version', v.id, { listing: `${publisher.handle}/${listing.name}`, version, reason: reason.slice(0, 200) });
  await notifyModerationAction({
    publisherOrgId: publisher.ownerOrgId,
    subject: `Version yanked: ${publisher.handle}/${listing.name} ${version}`,
    text: `${publisher.handle}/${listing.name} ${version} was yanked by the system org: ${reason}. It no longer resolves for new pipeline synths.`,
    // Installing orgs whose install reaches the yanked version hear too (N8).
    listing,
    version,
  });
  return yanked;
}

/** Apply a verified tier (verify request / moderation tier_verified). */
async function makeVerified(publisher: Publisher, actor: string, via: string): Promise<void> {
  // Eligibility is re-checked at decision time (§3.7): plan, verified domain, owner MFA.
  assertVerifiedEligible(await checkVerifiedEligibility(publisher.ownerOrgId ?? ''), 'decision');
  await publishers.update(publisher.id, { tier: 'verified', verifiedAt: new Date(), verifiedGraceUntil: null });
  await enqueueResign('publisher', publisher.id, 'tier_change', actor);
  audit('publisher.tier.change', actor, publisher, 'publisher', publisher.id, { from: publisher.tier, to: 'verified', via });
}

/**
 * Carry out an approved request. Throws on a refusal; the caller rolls the
 * status back. `human` marks a manager's decision (closes the bootstrap window).
 */
export async function execute(r: Req, publisher: Publisher, actor: string, opts: { human: boolean }): Promise<void> {
  const payload = payloadOf(r);
  const listing = r.listingId ? await listings.byId(r.listingId) : null;
  const needListing = (): PluginListing => {
    if (!listing) throw new EcosystemError(ErrorCode.NOT_FOUND, 'The listing no longer exists.');
    return listing;
  };

  switch (r.kind) {
    case 'new_listing':
    case 'new_version':
      await publishVersion(r, publisher, actor);
      break;
    case 'listing_update': {
      const l = needListing();
      const values = ((payload.metadata as RequestMetadata | undefined)?.values) ?? {};
      await listings.update(l.id, listingColumns(values));
      audit('plugin.listing.update', actor, publisher, 'plugin-listing', l.id, { listing: `${publisher.handle}/${l.name}`, fields: Object.keys(values) });
      break;
    }
    case 'yank':
      await yankListedVersion(needListing(), publisher, r.version!, (payload.reason as string | undefined) ?? r.reason ?? 'yank requested by the publisher', actor);
      break;
    case 'unpause': {
      const l = needListing();
      if (r.version) {
        const v = await versions.get(l.id, r.version);
        if (!v) throw new EcosystemError(ErrorCode.NOT_FOUND, 'Version not found');
        await versions.update(v.id, { pausedAt: null });
      } else {
        await listings.update(l.id, { pausedAt: null });
      }
      audit('plugin.listing.unpause', actor, publisher, 'plugin-listing', l.id, { listing: `${publisher.handle}/${l.name}`, ...(r.version ? { version: r.version } : {}) });
      break;
    }
    case 'transfer': {
      const l = needListing();
      const t = payload.transfer as { targetPublisherId?: string; targetOrgId?: string; response?: string } | undefined;
      if (t?.response !== 'accepted') throw new ConflictError('The receiving organization has not accepted the transfer yet.');
      const target = await publishers.byId(t.targetPublisherId ?? '');
      if (!target || target.suspendedAt) throw new ConflictError('The receiving publisher no longer exists or is suspended.');
      if (await listings.byName(target.id, l.name)) throw new ConflictError(`${target.handle} already has a listing named ${l.name}.`);
      await listings.update(l.id, { publisherId: target.id });
      await enqueueResign('listing', l.id, 'transfer', actor);
      audit('publisher.transfer.approve', actor, publisher, 'plugin-listing', l.id, { listing: l.name, from: publisher.handle, to: target.handle });
      await notifyTransferUpdate({ orgIds: [publisher.ownerOrgId, target.ownerOrgId], title: `${publisher.handle}/${l.name}`, outcome: 'approved' });
      break;
    }
    case 'claim': {
      const target = (payload.target ?? {}) as { handle?: string; listingId?: string };
      if (target.handle) {
        const refusal = await handleRefusal(target.handle, publisher.id);
        if (refusal && refusal.code !== ErrorCode.PUBLISHER_HANDLE_RESERVED) throw new ConflictError(refusal.message);
        await publishers.update(publisher.id, { handle: target.handle });
        await enqueueResign('publisher', publisher.id, 'handle_change', actor);
        audit('publisher.profile-change.approve', actor, publisher, 'publisher', publisher.id, { claim: true, from: publisher.handle, to: target.handle });
      } else {
        const claimed = await listings.byId(target.listingId ?? '');
        if (!claimed) throw new EcosystemError(ErrorCode.NOT_FOUND, 'The claimed listing no longer exists.');
        if (await listings.byName(publisher.id, claimed.name)) throw new ConflictError(`${publisher.handle} already has a listing named ${claimed.name}.`);
        await listings.update(claimed.id, { publisherId: publisher.id });
        await enqueueResign('listing', claimed.id, 'claim', actor);
        audit('publisher.transfer.approve', actor, publisher, 'plugin-listing', claimed.id, { claim: true, listing: claimed.name, to: publisher.handle });
        // E10: the claimer's verified email submitted it → link those submissions (N5).
        await (await submissionModeration()).linkClaimedSubmissions({
          listing: claimed,
          claimantEmailHash: (payload as { claimantEmailHash?: string }).claimantEmailHash,
          userId: r.submittedBy,
          orgId: r.submittedOrgId,
          actor,
          publisherHandle: publisher.handle,
        });
      }
      break;
    }
    case 'profile_change': {
      const target = (payload.target ?? {}) as { handle?: string; displayName?: string };
      const patch: Partial<Publisher> = {};
      if (target.handle && target.handle !== publisher.handle) {
        const refusal = await handleRefusal(target.handle, publisher.id);
        if (refusal) throw new ConflictError(refusal.message);
        patch.handle = target.handle;
      }
      if (target.displayName) patch.displayName = target.displayName;
      if (Object.keys(patch).length) await publishers.update(publisher.id, patch);
      if (patch.handle) await enqueueResign('publisher', publisher.id, 'handle_change', actor);
      audit('publisher.profile-change.approve', actor, publisher, 'publisher', publisher.id, { fields: Object.keys(patch), ...(patch.handle ? { from: publisher.handle, to: patch.handle } : {}) });
      break;
    }
    case 'verify':
      if (publisher.tier !== 'community') throw new ConflictError(`The publisher is ${publisher.tier}, not community.`);
      await makeVerified(publisher, actor, 'application');
      audit('publisher.verify.approve', actor, publisher, 'publisher', publisher.id, {});
      break;
    case 'moderation':
      await executeModeration(r, publisher, listing, actor);
      break;
    case 'advisory':
      // Only the system org publishes an advisory (W8): approving its request.
      await publishAdvisory(r, publisher, actor);
      break;
    case 'submission':
      // An anonymous submission (§4): publish the quarantined digest to public/community/*.
      await (await submissionModeration()).publishSubmission(r, publisher, actor);
      break;
    default:
      throw new EcosystemError(ErrorCode.VALIDATION_ERROR, `${r.kind} requests are not decided here.`);
  }
  if (opts.human) await closeBootstrap('first_reviewed_decision', actor);
}

/** The system-org two-person actions (§3.0.1): unyank, lifting a suspension, a tier change to Verified. */
async function executeModeration(r: Req, publisher: Publisher, listing: PluginListing | null, actor: string): Promise<void> {
  const action = payloadOf(r).action;
  if (action === 'unsuspend_publisher') {
    await publishers.update(publisher.id, { suspendedAt: null, suspendReason: null });
    await enqueueResign('publisher', publisher.id, 'unsuspend', actor);
    audit('publisher.unsuspend', actor, publisher, 'publisher', publisher.id, {});
    return;
  }
  if (action === 'tier_verified') {
    await makeVerified(publisher, actor, 'moderator');
    return;
  }
  if (!listing) throw new EcosystemError(ErrorCode.NOT_FOUND, 'The listing no longer exists.');
  if (action === 'relist') {
    await listings.update(listing.id, { state: 'listed' });
    audit('plugin.listing.state.change', actor, publisher, 'plugin-listing', listing.id, { listing: listing.name, from: listing.state, to: 'listed' });
    return;
  }
  if (action === 'unyank') {
    const v = await versions.get(listing.id, r.version ?? '');
    if (!v || !v.yankedAt) throw new ConflictError('The version is not yanked.');
    if (v.imageDigest && v.imageRepository) {
      // Re-tag from the LISTING VERSION: the yank removed only the tag, so the
      // manifest is still in `public/*` — the source org's row (possibly
      // deleted by now) is never needed. Deployed pipelines pull by digest
      // either way, so a failed re-tag doesn't block the unyank.
      await retagImage({ imageRepository: v.imageRepository, version: v.version, digest: v.imageDigest })
        .catch((err) => {
          emitCounter('ecosystem_registry_retag_failed_total', {});
          logger.warn('Re-tagging the unyanked version failed; pinned digests still pull', { error: errorMessage(err) });
        });
      await invalidateVerifyCache({ imageRepository: v.imageRepository, digest: v.imageDigest }).catch(() => undefined);
    }
    await versions.update(v.id, { yankedAt: null, yankReason: null });
    const live = (await versions.forListings([listing.id])).filter((x) => !x.yankedAt || x.id === v.id).map((x) => x.version);
    await listings.update(listing.id, { latestVersion: latestVersion(live) });
    audit('plugin.version.unyank', actor, publisher, 'plugin-listing-version', v.id, { listing: listing.name, version: v.version });
    return;
  }
  throw new EcosystemError(ErrorCode.VALIDATION_ERROR, `Unknown moderation action ${String(action)}`);
}

// -----------------------------------------------------------------------------
// Manager decisions
// -----------------------------------------------------------------------------

async function loadForDecision(moderator: Caller, id: string): Promise<{ r: Req; publisher: Publisher }> {
  const r = await requests.byId(id);
  if (!r) throw new EcosystemError(ErrorCode.NOT_FOUND, 'Request not found');
  const permission = requiredDecisionPermission(r.kind);
  if (!can(moderator, permission)) {
    throw new EcosystemError(ErrorCode.INSUFFICIENT_PERMISSIONS, `Deciding ${r.kind} requests needs ${permission}.`);
  }
  const publisher = await publishers.byId(r.publisherId);
  if (!publisher) throw new EcosystemError(ErrorCode.NOT_FOUND, 'Publisher not found');
  return { r, publisher };
}

async function assertNoConflict(moderator: Caller, r: Req, publisher: Publisher): Promise<void> {
  const plugin = r.pluginId && publisher.handle === OFFICIAL_PUBLISHER_HANDLE ? await plugins.byId(r.pluginId) : null;
  const c = await conflictOfInterest(moderator, r, publisher, { deep: true, plugin });
  if (c.conflict) {
    emitCounter('ecosystem_separation_of_duties_refused_total', { kind: r.kind });
    throw new EcosystemError(ErrorCode.SEPARATION_OF_DUTIES, c.reason!);
  }
}

/** Run an approved request, rolling the status back to `from` when execution refuses. */
async function executeClaimed(claimed: Req, from: PublishRequestStatus, rollback: Partial<Req>, publisher: Publisher, moderator: Caller): Promise<void> {
  try {
    await execute(claimed, publisher, actorId({ userId: moderator.userId }), { human: true });
  } catch (err) {
    const current = await requests.byId(claimed.id);
    // A quota refusal already recorded the request as rejected; leave it.
    if (current?.status === 'approved') await requests.transition(claimed.id, 'approved', { status: from, ...rollback });
    throw err;
  }
}

/**
 * POST /ecosystem/requests/:id/approve — the first (or only) approval. A
 * two-person request moves to `pending_second_approval` (N28); anything else
 * executes now.
 */
export async function approve(moderator: Caller, id: string, note: string | null): Promise<{ request: Req; executed: boolean }> {
  const { r, publisher } = await loadForDecision(moderator, id);
  if (r.status === 'pending_second_approval') throw new ConflictError('This request already has its first approval; use second-approve.');
  if (r.status !== 'pending') throw new ConflictError(`This request is ${r.status}.`);
  await assertNoConflict(moderator, r, publisher);
  const actor = actorId({ userId: moderator.userId });
  const title = await titleOf(r, publisher);

  if (r.kind === 'verify') assertVerifiedEligible(await checkVerifiedEligibility(publisher.ownerOrgId ?? ''), 'decision');
  if (needsTwoPerson(r.kind, publisher.tier)) {
    const parked = await requests.transition(r.id, 'pending', { status: 'pending_second_approval', firstApprovedBy: moderator.userId, ...(note ? { reason: note } : {}) });
    if (!parked) throw new ConflictError('The request was decided by someone else.');
    audit('plugin.request.approve', actor, publisher, 'plugin-publish-request', r.id, { kind: r.kind, firstOfTwo: true });
    await notifySecondApprovalNeeded({ title, firstApprover: moderator.userId, submittedOrgId: r.submittedOrgId, permission: requiredDecisionPermission(r.kind) });
    return { request: parked, executed: false };
  }

  const claimed = await requests.transition(r.id, 'pending', { status: 'approved', decidedBy: moderator.userId, decidedAt: new Date(), ...(note ? { reason: note } : {}) });
  if (!claimed) throw new ConflictError('The request was decided by someone else.');
  await executeClaimed(claimed, 'pending', { decidedBy: null, decidedAt: null, reason: r.reason }, publisher, moderator);
  audit('plugin.request.approve', actor, publisher, 'plugin-publish-request', r.id, { kind: r.kind, ...(r.version ? { version: r.version } : {}), ...(r.digest ? { digest: r.digest } : {}) });
  if (r.kind === 'verify') audit('publisher.verify.approve', actor, publisher, 'publisher', publisher.id, {});
  await notifyDecision({ kind: r.kind, title, publisherOrgId: publisher.ownerOrgId, approved: true, reason: note });
  return { request: (await requests.byId(r.id))!, executed: true };
}

/** POST /ecosystem/requests/:id/second-approve — the second of two approvals, by a DIFFERENT manager. */
export async function secondApprove(moderator: Caller, id: string, note: string | null): Promise<{ request: Req; executed: true }> {
  const { r, publisher } = await loadForDecision(moderator, id);
  if (r.status !== 'pending_second_approval') throw new ConflictError('This request is not waiting for a second approval.');
  // conflictOfInterest refuses the first approver (and the submitter/uploader).
  await assertNoConflict(moderator, r, publisher);
  const claimed = await requests.transition(r.id, 'pending_second_approval', {
    status: 'approved', secondApprovedBy: moderator.userId, decidedBy: moderator.userId, decidedAt: new Date(),
  });
  if (!claimed) throw new ConflictError('The request was decided by someone else.');
  await executeClaimed(claimed, 'pending_second_approval', { secondApprovedBy: null, decidedBy: null, decidedAt: null }, publisher, moderator);
  const actor = actorId({ userId: moderator.userId });
  audit('plugin.request.second-approve', actor, publisher, 'plugin-publish-request', r.id, { kind: r.kind, firstApprovedBy: r.firstApprovedBy, ...(note ? { note: note.slice(0, 200) } : {}) });
  await notifyDecision({ kind: r.kind, title: await titleOf(r, publisher), publisherOrgId: publisher.ownerOrgId, approved: true, reason: note });
  return { request: (await requests.byId(r.id))!, executed: true };
}

/** Clear a version's request freeze once nothing open references it and it isn't listed. */
export async function releaseFreeze(pluginId: string | null): Promise<void> {
  if (!pluginId) return;
  const open = await requests.list({ pluginId, statuses: OPEN_STATUSES, limit: 1 });
  if (open.length > 0) return;
  if ((await versions.bySourcePlugins([pluginId])).length > 0) return;
  await plugins.unfreeze(pluginId);
}

/** POST /ecosystem/requests/:id/reject — decline with a reason (N25 / N7 / N10). */
export async function reject(moderator: Caller, id: string, reason: string): Promise<Req> {
  const { r, publisher } = await loadForDecision(moderator, id);
  if (!OPEN_STATUSES.includes(r.status)) throw new ConflictError(`This request is ${r.status}.`);
  await assertNoConflict(moderator, { ...r, status: 'pending' }, publisher);
  const rejected = await requests.transition(r.id, r.status, { status: 'rejected', reason, decidedBy: moderator.userId, decidedAt: new Date() });
  if (!rejected) throw new ConflictError('The request was decided by someone else.');
  await releaseFreeze(r.pluginId);
  await discardDraft(r);
  const actor = actorId({ userId: moderator.userId });
  audit('plugin.request.reject', actor, publisher, 'plugin-publish-request', r.id, { kind: r.kind, reason: reason.slice(0, 200) });
  if (r.kind === 'submission') await (await submissionModeration()).rejectSubmission(r, reason, actor);
  const extra: Record<string, Parameters<typeof emitPluginAudit>[0]['action']> = {
    verify: 'publisher.verify.reject', transfer: 'publisher.transfer.reject', profile_change: 'publisher.profile-change.reject',
  };
  if (extra[r.kind]) audit(extra[r.kind]!, actor, publisher, 'publisher', publisher.id, { requestId: r.id });
  const title = await titleOf(r, publisher);
  if (r.kind === 'transfer') {
    const t = payloadOf(r).transfer as { targetOrgId?: string } | undefined;
    await notifyTransferUpdate({ orgIds: [publisher.ownerOrgId, t?.targetOrgId ?? null], title, outcome: 'rejected' });
  } else {
    await notifyDecision({ kind: r.kind, title, publisherOrgId: publisher.ownerOrgId, approved: false, reason });
  }
  return rejected;
}
