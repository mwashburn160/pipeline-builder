// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Executing an approved publish request, per kind: publishing the PINNED
 * digest into `public/<publisher>/<name>` with a fresh tier-annotated
 * signature, listing updates, transfers and claims, profile changes,
 * Verified, advisories, submissions and the system-org moderation actions.
 */

import { ConflictError, createLogger, ErrorCode, errorMessage, SYSTEM_ORG_ID } from '@pipeline-builder/api-core';
import { incCounter } from '@pipeline-builder/api-server';
import { Config, pluginImageRepository } from '@pipeline-builder/pipeline-core';
import { type PluginListing, type PluginListingVersion, type PluginPublishRequest, type Publisher } from '@pipeline-builder/pipeline-data';

import { publishAdvisory } from './advisories.js';
import { ecosystemAudit } from './audit.js';
import { closeBootstrap } from './bootstrap.js';
import { EcosystemError } from './context.js';
import { announceNewVersion } from './install-notify.js';
import { effectiveMetadata, listingColumns, type RequestMetadata } from './metadata.js';
import { notifyModerationAction, notifyTransferUpdate } from './notify.js';
import { specSnapshot } from './policy.js';
import { handleRefusal, listingsQuotaOrThrow } from './publishers.js';
import { invalidateVerifyCache, publishImage, retagImage, yankImage } from './registry.js';
import { enqueueResign, kickResignJobs, signedAs, trustFor } from './resign.js';
import { atomically, listings, plugins, publishers, recomputeLatest, requests, versions, type PluginRow } from './store.js';
import { linkClaimedSubmissions, publishSubmission } from './submission-moderation.js';
import { isActiveListing } from './util.js';
import { assertVerifiedEligible, checkVerifiedEligibility } from './verified-eligibility.js';
import { resolveBaseImageCreatedAt } from '../../helpers/base-image.js';
import type { RegistryInfo } from '../../helpers/registry-auth.js';

const logger = createLogger('ecosystem-execute');

type Req = PluginPublishRequest;
const payloadOf = (r: Req) => (r.payload ?? {}) as Record<string, unknown>;

// -----------------------------------------------------------------------------
// Execution per kind
// -----------------------------------------------------------------------------

/**
 * The base image `created` time recorded on a listed version (its freshness).
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


/** Refuse (and record) a request that exceeds the `listings` quota at APPROVAL. */
async function rejectForQuota(r: Req, publisher: Publisher, actor: string, used: number, limit: number): Promise<never> {
  // The request was claimed as approved; record the quota refusal instead.
  await requests.transition(r.id, 'approved', { status: 'rejected', reason: 'listings_quota', decidedBy: actor, decidedAt: new Date() });
  ecosystemAudit({ action: 'plugin.request.reject', actor, affectedOrgId: publisher.ownerOrgId, targetType: 'plugin-publish-request', targetId: r.id, details: { kind: r.kind, reason: 'listings_quota', used, limit } });
  throw new EcosystemError(ErrorCode.QUOTA_EXCEEDED, `The publisher is at its listings limit (${used}/${limit}); the request was rejected.`, { quotaType: 'listings', used, limit, rejected: true });
}

/** The plugin row a version request pinned, checked against the pin (fail closed). */
async function pinnedPlugin(r: Req, publisher: Publisher): Promise<PluginRow> {
  const plugin = r.pluginId ? await plugins.byId(r.pluginId, publisher.ownerOrgId ?? undefined) : null;
  if (!plugin) throw new EcosystemError(ErrorCode.NOT_FOUND, 'The requested plugin version no longer exists.');
  if ((plugin.imageDigest ?? null) !== (r.digest ?? null) || plugin.version !== r.version) {
    throw new ConflictError('The plugin version no longer matches the digest the request pinned.', ErrorCode.PLUGIN_DIGEST_MISMATCH);
  }
  // only a PUBLIC version is ever published — the org may have narrowed it
  // after asking (the freeze now refuses that, but approval re-checks anyway).
  if (plugin.visibility !== 'public') {
    throw new ConflictError(`The plugin version is ${plugin.visibility ?? 'not public'}; only a public version can be published.`);
  }
  return plugin;
}

/**
 * The listing a new_listing publishes into: none yet, or an EMPTY shell of this
 * publisher (a listing row with no versions — what an earlier, interrupted
 * publish could leave behind) which is reused rather than refused.
 */
async function reusableListing(listing: PluginListing | null, publisher: Publisher, name: string): Promise<PluginListing | null> {
  if (!listing) return null;
  if (listing.publisherId === publisher.id && (await versions.countForListing(listing.id)) === 0) return listing;
  throw new ConflictError(`${publisher.handle} already has a listing named ${name}.`);
}

/**
 * Publish a pinned version into `public/*` and record it on the listing
 * (new_listing / new_version). Order: every check, then the image copy
 * (idempotent server-side: a retry re-copies the same digest), then EVERY
 * database write in one transaction — listing, version, latest pointer, the
 * request's listing link — so a failure leaves nothing half-recorded; the
 * audit and the installer notices only after it committed.
 */
async function publishVersion(r: Req, publisher: Publisher, actor: string): Promise<void> {
  const plugin = await pinnedPlugin(r, publisher);
  const payload = payloadOf(r);
  const metadata = (payload.metadata as RequestMetadata | undefined) ?? effectiveMetadata(plugin);
  let listing = r.listingId ? await listings.byId(r.listingId) : await listings.byName(publisher.id, plugin.name);

  if (r.kind === 'new_listing') {
    listing = await reusableListing(listing, publisher, plugin.name);
    if (publisher.ownerOrgId && publisher.ownerOrgId !== SYSTEM_ORG_ID) {
      const quota = await listingsQuotaOrThrow(publisher.ownerOrgId, publisher.id);
      if (quota.limit !== -1 && quota.used >= quota.limit) await rejectForQuota(r, publisher, actor, quota.used, quota.limit);
    }
  } else {
    if (!listing || !isActiveListing(listing)) {
      throw new ConflictError('The listing is not live (suspended or transferred); the version cannot be published.');
    }
    if (await versions.get(listing.id, plugin.version)) throw new ConflictError(`${plugin.version} is already published to this listing.`);
    if (r.lane !== 'security' && publisher.ownerOrgId && publisher.ownerOrgId !== SYSTEM_ORG_ID) {
      const quota = await listingsQuotaOrThrow(publisher.ownerOrgId, publisher.id);
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

  const { target, version, updated } = await atomically(async () => {
    const into = listing ?? await listings.insert({
      publisherId: publisher.id,
      name: plugin.name,
      ...listingColumns(metadata.values),
      latestVersion: plugin.version,
    });
    const inserted = await versions.insert({
      listingId: into.id,
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
    const latest = await recomputeLatest(into.id);
    if (!r.listingId) await requests.transition(r.id, 'approved', { listingId: into.id });
    return { target: into, version: inserted, updated: latest };
  });
  ecosystemAudit({
    action: 'plugin.listing.publish',
    actor,
    affectedOrgId: publisher.ownerOrgId,
    targetType: 'plugin-listing-version',
    targetId: version.id,
    details: {
      listing: `${publisher.handle}/${plugin.name}`, version: plugin.version, digest: plugin.imageDigest, tier: publisher.tier, kind: r.kind,
    },
  });
  // N27 / N13 to the installing orgs (a brand-new listing has none yet).
  if (r.kind === 'new_version') await announceNewVersion(publisher, updated ?? target, version);
}

/** Yank a listed version (system org): stop it resolving, drop the public tag, tell the publisher (N8). */
export async function yankListedVersion(listing: PluginListing, publisher: Publisher, version: string, reason: string, actor: string): Promise<PluginListingVersion> {
  const v = await versions.get(listing.id, version);
  if (!v) throw new EcosystemError(ErrorCode.NOT_FOUND, 'Version not found');
  if (v.yankedAt) throw new ConflictError(`${version} is already yanked.`);
  // Resolution reads listing versions, so the yank stops new
  // synths resolving it for every installer at once. The yank and the listing's
  // latest pointer commit together.
  const yanked = await atomically(async () => {
    const y = (await versions.update(v.id, { yankedAt: new Date(), yankReason: reason }))!;
    await recomputeLatest(listing.id, { exceptId: v.id });
    return y;
  });
  if (v.imageRepository && v.imageDigest) {
    await yankImage({ imageRepository: v.imageRepository, version, digest: v.imageDigest }).catch((err) => {
      incCounter('ecosystem_registry_yank_failed_total', {});
      logger.warn('public/* tag removal failed (the version is yanked in the catalog regardless)', { version, error: errorMessage(err) });
    });
    await invalidateVerifyCache({ imageRepository: v.imageRepository, digest: v.imageDigest }).catch(() => undefined);
  }
  ecosystemAudit({ action: 'plugin.version.yank', actor, affectedOrgId: publisher.ownerOrgId, targetType: 'plugin-listing-version', targetId: v.id, details: { listing: `${publisher.handle}/${listing.name}`, version, reason: reason.slice(0, 200) } });
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
  // Eligibility is re-checked at decision time: plan, verified domain, owner MFA.
  assertVerifiedEligible(await checkVerifiedEligibility(publisher.ownerOrgId ?? ''), 'decision');
  await atomically(async () => {
    await publishers.update(publisher.id, { tier: 'verified', verifiedAt: new Date(), verifiedGraceUntil: null });
    await enqueueResign('publisher', publisher.id, 'tier_change', actor, signedAs(publisher));
  });
  ecosystemAudit({ action: 'publisher.tier.change', actor, affectedOrgId: publisher.ownerOrgId, targetType: 'publisher', targetId: publisher.id, details: { from: publisher.tier, to: 'verified', via } });
}

/** What every per-kind executor receives. */
interface Execution {
  r: Req;
  publisher: Publisher;
  /** The request's listing (null for a new listing or when it no longer exists). */
  listing: PluginListing | null;
  actor: string;
  payload: Record<string, unknown>;
}

function needListing(e: Execution): PluginListing {
  if (!e.listing) throw new EcosystemError(ErrorCode.NOT_FOUND, 'The listing no longer exists.');
  return e.listing;
}

async function executeListingUpdate(e: Execution): Promise<void> {
  const l = needListing(e);
  const values = ((e.payload.metadata as RequestMetadata | undefined)?.values) ?? {};
  await listings.update(l.id, listingColumns(values));
  ecosystemAudit({ action: 'plugin.listing.update', actor: e.actor, affectedOrgId: e.publisher.ownerOrgId, targetType: 'plugin-listing', targetId: l.id, details: { listing: `${e.publisher.handle}/${l.name}`, fields: Object.keys(values) } });
}

async function executeUnpause(e: Execution): Promise<void> {
  const { r, publisher, actor } = e;
  const l = needListing(e);
  if (r.version) {
    const v = await versions.get(l.id, r.version);
    if (!v) throw new EcosystemError(ErrorCode.NOT_FOUND, 'Version not found');
    await versions.update(v.id, { pausedAt: null });
  } else {
    await listings.update(l.id, { pausedAt: null });
  }
  ecosystemAudit({ action: 'plugin.listing.unpause', actor, affectedOrgId: publisher.ownerOrgId, targetType: 'plugin-listing', targetId: l.id, details: { listing: `${publisher.handle}/${l.name}`, ...(r.version ? { version: r.version } : {}) } });
}

async function executeTransfer(e: Execution): Promise<void> {
  const { publisher, actor } = e;
  const l = needListing(e);
  const t = e.payload.transfer as { targetPublisherId?: string; targetOrgId?: string; response?: string } | undefined;
  if (t?.response !== 'accepted') throw new ConflictError('The receiving organization has not accepted the transfer yet.');
  const target = await publishers.byId(t.targetPublisherId ?? '');
  if (!target || target.suspendedAt) throw new ConflictError('The receiving publisher no longer exists or is suspended.');
  if (await listings.byName(target.id, l.name)) throw new ConflictError(`${target.handle} already has a listing named ${l.name}.`);
  // The move and its re-sign job commit together; the old publisher's
  // signature stays acceptable until the listing's images are re-signed.
  await atomically(async () => {
    await listings.update(l.id, { publisherId: target.id });
    await enqueueResign('listing', l.id, 'transfer', actor, signedAs(publisher));
  });
  ecosystemAudit({ action: 'publisher.transfer.approve', actor, affectedOrgId: publisher.ownerOrgId, targetType: 'plugin-listing', targetId: l.id, details: { listing: l.name, from: publisher.handle, to: target.handle } });
  await notifyTransferUpdate({ orgIds: [publisher.ownerOrgId, target.ownerOrgId], title: `${publisher.handle}/${l.name}`, outcome: 'approved' });
}

async function executeClaim({ r, publisher, actor, payload }: Execution): Promise<void> {
  const target = (payload.target ?? {}) as { handle?: string; listingId?: string };
  if (target.handle) {
    const refusal = await handleRefusal(target.handle, publisher.id);
    if (refusal && refusal.code !== ErrorCode.PUBLISHER_HANDLE_RESERVED) throw new ConflictError(refusal.message);
    await atomically(async () => {
      await publishers.update(publisher.id, { handle: target.handle });
      await enqueueResign('publisher', publisher.id, 'handle_change', actor, signedAs(publisher));
    });
    ecosystemAudit({ action: 'publisher.profile-change.approve', actor, affectedOrgId: publisher.ownerOrgId, targetType: 'publisher', targetId: publisher.id, details: { claim: true, from: publisher.handle, to: target.handle } });
    return;
  }
  const claimed = await listings.byId(target.listingId ?? '');
  if (!claimed) throw new EcosystemError(ErrorCode.NOT_FOUND, 'The claimed listing no longer exists.');
  if (await listings.byName(publisher.id, claimed.name)) throw new ConflictError(`${publisher.handle} already has a listing named ${claimed.name}.`);
  const from = await publishers.byId(claimed.publisherId);
  await atomically(async () => {
    await listings.update(claimed.id, { publisherId: publisher.id });
    await enqueueResign('listing', claimed.id, 'claim', actor, from ? signedAs(from) : null);
  });
  ecosystemAudit({ action: 'publisher.transfer.approve', actor, affectedOrgId: publisher.ownerOrgId, targetType: 'plugin-listing', targetId: claimed.id, details: { claim: true, listing: claimed.name, to: publisher.handle } });
  // The claimer's verified email submitted it → link those submissions (N5).
  await linkClaimedSubmissions({
    listing: claimed,
    claimantEmailHash: (payload as { claimantEmailHash?: string }).claimantEmailHash,
    userId: r.submittedBy,
    orgId: r.submittedOrgId,
    actor,
    publisherHandle: publisher.handle,
  });
}

async function executeProfileChange({ publisher, actor, payload }: Execution): Promise<void> {
  const target = (payload.target ?? {}) as { handle?: string; displayName?: string };
  const patch: Partial<Publisher> = {};
  if (target.handle && target.handle !== publisher.handle) {
    const refusal = await handleRefusal(target.handle, publisher.id);
    if (refusal) throw new ConflictError(refusal.message);
    patch.handle = target.handle;
  }
  if (target.displayName) patch.displayName = target.displayName;
  await atomically(async () => {
    if (Object.keys(patch).length) await publishers.update(publisher.id, patch);
    if (patch.handle) await enqueueResign('publisher', publisher.id, 'handle_change', actor, signedAs(publisher));
  });
  ecosystemAudit({ action: 'publisher.profile-change.approve', actor, affectedOrgId: publisher.ownerOrgId, targetType: 'publisher', targetId: publisher.id, details: { fields: Object.keys(patch), ...(patch.handle ? { from: publisher.handle, to: patch.handle } : {}) } });
}

async function executeVerify({ publisher, actor }: Execution): Promise<void> {
  if (publisher.tier !== 'community') throw new ConflictError(`The publisher is ${publisher.tier}, not community.`);
  await makeVerified(publisher, actor, 'application');
  ecosystemAudit({ action: 'publisher.verify.approve', actor, affectedOrgId: publisher.ownerOrgId, targetType: 'publisher', targetId: publisher.id, details: {} });
}

/** How each request kind executes once approved. */
const EXECUTORS: Record<string, (e: Execution) => Promise<void>> = {
  new_listing: (e) => publishVersion(e.r, e.publisher, e.actor),
  new_version: (e) => publishVersion(e.r, e.publisher, e.actor),
  listing_update: executeListingUpdate,
  yank: async (e) => {
    await yankListedVersion(needListing(e), e.publisher, e.r.version!, (e.payload.reason as string | undefined) ?? e.r.reason ?? 'yank requested by the publisher', e.actor);
  },
  unpause: executeUnpause,
  transfer: executeTransfer,
  claim: executeClaim,
  profile_change: executeProfileChange,
  verify: executeVerify,
  moderation: (e) => executeModeration(e.r, e.publisher, e.listing, e.actor),
  // Only the system org publishes an advisory: by approving its request.
  advisory: async (e) => { await publishAdvisory(e.r, e.publisher, e.actor); },
  // An anonymous submission: publish the quarantined digest to public/community/*.
  submission: (e) => publishSubmission(e.r, e.publisher, e.actor),
};

/**
 * Carry out an approved request. Throws on a refusal; the caller rolls the
 * status back. `human` marks a manager's decision (closes the bootstrap window).
 */
export async function execute(r: Req, publisher: Publisher, actor: string, opts: { human: boolean }): Promise<void> {
  const executor = Object.hasOwn(EXECUTORS, r.kind) ? EXECUTORS[r.kind] : undefined;
  if (!executor) throw new EcosystemError(ErrorCode.VALIDATION_ERROR, `${r.kind} requests are not decided here.`);
  const listing = r.listingId ? await listings.byId(r.listingId) : null;
  await executor({ r, publisher, listing, actor, payload: payloadOf(r) });
  if (opts.human) await closeBootstrap('first_reviewed_decision', actor);
  // A decision that queued a re-sign (tier, handle, owner, suspension) starts it
  // now — the job committed with the change above.
  if (RESIGNING_KINDS.has(r.kind)) kickResignJobs();
}

/** Request kinds whose execution may queue a re-sign job. */
const RESIGNING_KINDS = new Set(['transfer', 'claim', 'profile_change', 'verify', 'moderation']);

/** Lift a suspension: its images are signed `unverified` (trustFor while suspended) and accepted until re-signed. */
async function unsuspendPublisher(publisher: Publisher, actor: string): Promise<void> {
  await atomically(async () => {
    await publishers.update(publisher.id, { suspendedAt: null, suspendReason: null });
    await enqueueResign('publisher', publisher.id, 'unsuspend', actor, signedAs(publisher));
  });
  ecosystemAudit({ action: 'publisher.unsuspend', actor, affectedOrgId: publisher.ownerOrgId, targetType: 'publisher', targetId: publisher.id, details: {} });
}

async function relistListing(publisher: Publisher, listing: PluginListing, actor: string): Promise<void> {
  await listings.update(listing.id, { state: 'listed' });
  ecosystemAudit({ action: 'plugin.listing.state.change', actor, affectedOrgId: publisher.ownerOrgId, targetType: 'plugin-listing', targetId: listing.id, details: { listing: listing.name, from: listing.state, to: 'listed' } });
}

async function unyankVersion(r: Req, publisher: Publisher, listing: PluginListing, actor: string): Promise<void> {
  const v = await versions.get(listing.id, r.version ?? '');
  if (!v || !v.yankedAt) throw new ConflictError('The version is not yanked.');
  if (v.imageDigest && v.imageRepository) {
    // Re-tag from the LISTING VERSION: the yank removed only the tag, so the
    // manifest is still in `public/*` — the source org's row (possibly
    // deleted by now) is never needed. Deployed pipelines pull by digest
    // either way, so a failed re-tag doesn't block the unyank.
    await retagImage({ imageRepository: v.imageRepository, version: v.version, digest: v.imageDigest })
      .catch((err) => {
        incCounter('ecosystem_registry_retag_failed_total', {});
        logger.warn('Re-tagging the unyanked version failed; pinned digests still pull', { error: errorMessage(err) });
      });
    await invalidateVerifyCache({ imageRepository: v.imageRepository, digest: v.imageDigest }).catch(() => undefined);
  }
  await atomically(async () => {
    await versions.update(v.id, { yankedAt: null, yankReason: null });
    await recomputeLatest(listing.id, { includeId: v.id });
  });
  ecosystemAudit({ action: 'plugin.version.unyank', actor, affectedOrgId: publisher.ownerOrgId, targetType: 'plugin-listing-version', targetId: v.id, details: { listing: listing.name, version: v.version } });
}

/** The listing a listing-scoped moderation action acts on, or 404. */
function requireListing(listing: PluginListing | null): PluginListing {
  if (!listing) throw new EcosystemError(ErrorCode.NOT_FOUND, 'The listing no longer exists.');
  return listing;
}

type ModerationHandler = (r: Req, publisher: Publisher, listing: PluginListing | null, actor: string) => Promise<void>;

/** The system-org two-person actions: lifting a suspension, a tier change to Verified, relisting, unyank. */
const MODERATION_ACTIONS: Record<string, ModerationHandler> = {
  unsuspend_publisher: (_r, publisher, _l, actor) => unsuspendPublisher(publisher, actor),
  tier_verified: (_r, publisher, _l, actor) => makeVerified(publisher, actor, 'moderator'),
  relist: (_r, publisher, listing, actor) => relistListing(publisher, requireListing(listing), actor),
  unyank: (r, publisher, listing, actor) => unyankVersion(r, publisher, requireListing(listing), actor),
};

async function executeModeration(r: Req, publisher: Publisher, listing: PluginListing | null, actor: string): Promise<void> {
  const action = payloadOf(r).action;
  const handler = typeof action === 'string' && Object.hasOwn(MODERATION_ACTIONS, action) ? MODERATION_ACTIONS[action] : undefined;
  if (!handler) throw new EcosystemError(ErrorCode.VALIDATION_ERROR, `Unknown moderation action ${String(action)}`);
  await handler(r, publisher, listing, actor);
}
