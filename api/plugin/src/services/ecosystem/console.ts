// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The Ecosystem console's system-org operations (docs/plans/plugin-ecosystem.md
 * §3.0, §3.0.1, §3.6, §5a.1): the queue and its review data, publishers and
 * their tier/suspension, listing state and yanks, the auto-approval rules and
 * the reserved-name list. Every function is reached only through
 * `requireEcosystemPermission` (system org + permission + aal2).
 *
 * Restricting actions apply at once (suspend, unmaintain, yank, disabling a
 * rule, a downgrade to Community). Expanding ones need a SECOND manager
 * (§3.0.1): lifting a suspension, unyanking, a tier change to Verified — each
 * becomes a `moderation` request parked in `pending_second_approval` — and
 * creating, enabling or widening a rule (its `pendingChange`).
 */

import {
  actorId,
  ErrorCode,
  isOfficialAutoApprovalEnabled,
  OFFICIAL_CATALOG_LOADER_ACCOUNT,
  publisherTermsVersion,
  SYSTEM_ORG_ID,
  VERIFY_REQUEST_KINDS,
} from '@pipeline-builder/api-core';
import {
  type EcosystemAutoApprovalRule,
  type PluginListing,
  type PluginPublishRequest,
  type Publisher,
  type PublishRequestKind,
  type PublishRequestStatus,
} from '@pipeline-builder/pipeline-data';
import { z } from 'zod';

import { advisoryStore, advisoryViews } from './advisories.js';
import { EcosystemError, type Caller } from './context.js';
import { bootstrapState, conflictOfInterest, ruleFlagOn, yankListedVersion } from './decisions.js';
import { notifyListingUnmaintained } from './install-notify.js';
import { notifyModerationAction, notifySecondApprovalNeeded } from './notify.js';
import { platformReads, type ApproverCount, type DecisionPermission } from './platform-reads.js';
import { requiredDecisionPermission, widensRule, type AutoRuleConditions } from './policy.js';
import { invalidateVerifyCache } from './registry.js';
import { enqueueResign, pendingResignJobs } from './resign.js';
import { reviewDiff } from './review.js';
import { listingStats } from './reviews-store.js';
import { listings, OPEN_STATUSES, plugins, publishers, requests, reservedNames, rules, versions } from './store.js';
import { claimEmailMatch, submissionReview } from './submission-moderation.js';
import { assertVerifiedEligible, checkVerifiedEligibility } from './verified-eligibility.js';
import { listingView, publisherView, queueItemView, ruleView } from './views.js';
import { emitPluginAudit } from '../audit.js';

const actor = (c: Caller) => actorId({ userId: c.userId });

function audit(c: Caller, action: Parameters<typeof emitPluginAudit>[0]['action'], affectedOrgId: string | null, targetType: string, targetId: string, details: Record<string, unknown>): void {
  emitPluginAudit({ action, actorId: actor(c), orgId: SYSTEM_ORG_ID, ...(affectedOrgId ? { affectedOrgId } : {}), targetType, targetId, details });
}

function requireReason(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') throw new EcosystemError(ErrorCode.MISSING_REQUIRED_FIELD, 'reason is required');
  return value.trim().slice(0, 1000);
}

// -----------------------------------------------------------------------------
// Overview + queue
// -----------------------------------------------------------------------------

/**
 * The approver floor (§3.0.1, §9a "Staffing"): at least THREE Ecosystem
 * Managers so two-person approval and holiday cover always work; below TWO
 * eligible approvers a superadmin must act as the second one.
 */
export const MIN_ECOSYSTEM_MANAGERS = 3;
export const TWO_PERSON_MIN_APPROVERS = 2;

/** An approver count with its shortage flags (null count = platform didn't answer). */
export interface ApproverStanding {
  permission: DecisionPermission;
  count: ApproverCount | null;
  /** Fewer holders than {@link MIN_ECOSYSTEM_MANAGERS}. */
  belowMinimum: boolean;
  /** Fewer eligible approvers than two-person approval needs. */
  belowTwoPerson: boolean;
}

function standing(permission: DecisionPermission, count: ApproverCount | null): ApproverStanding {
  return {
    permission,
    count,
    belowMinimum: count !== null && count.holders < MIN_ECOSYSTEM_MANAGERS,
    belowTwoPerson: count !== null && count.eligible < TWO_PERSON_MIN_APPROVERS,
  };
}

/** The system org's approver standing for both decision permissions (no conflicts applied). */
export async function approverStanding(): Promise<{ minimum: number; twoPersonMinimum: number; moderate: ApproverStanding; verify: ApproverStanding }> {
  const [moderate, verify] = await Promise.all([
    platformReads().approvers('plugins:moderate'),
    platformReads().approvers('publishers:verify'),
  ]);
  return {
    minimum: MIN_ECOSYSTEM_MANAGERS,
    twoPersonMinimum: TWO_PERSON_MIN_APPROVERS,
    moderate: standing('plugins:moderate', moderate),
    verify: standing('publishers:verify', verify),
  };
}

/**
 * Who could decide `r` (§3.0.1): the holders of its decision permission minus
 * the requester's conflicts — members of the requesting, publishing and
 * receiving orgs, the submitter, and (awaiting a second approval) the first
 * approver.
 */
export async function requestApprovers(r: PluginPublishRequest, publisher: Publisher | null): Promise<ApproverStanding> {
  const orgIds = new Set<string>();
  if (r.submittedOrgId) orgIds.add(r.submittedOrgId.toLowerCase());
  if (publisher?.ownerOrgId) orgIds.add(publisher.ownerOrgId.toLowerCase());
  const target = ((r.payload ?? {}) as { transfer?: { targetOrgId?: string } }).transfer?.targetOrgId;
  if (target) orgIds.add(target.toLowerCase());
  orgIds.delete(SYSTEM_ORG_ID);
  const userIds = [r.submittedBy, r.status === 'pending_second_approval' ? r.firstApprovedBy : null].filter((u): u is string => !!u);
  const permission = requiredDecisionPermission(r.kind) as DecisionPermission;
  return standing(permission, await platformReads().approvers(permission, { orgIds: [...orgIds], userIds }));
}

/** GET /ecosystem/overview */
export async function overview() {
  const open = await requests.list({ statuses: OPEN_STATUSES, limit: 1000 });
  const bootstrap = await bootstrapState();
  return {
    approvers: await approverStanding(),
    pending: {
      standard: open.filter((r) => r.lane === 'standard' && r.status === 'pending').length,
      security: open.filter((r) => r.lane === 'security').length,
      secondApproval: open.filter((r) => r.status === 'pending_second_approval').length,
      verify: open.filter((r) => VERIFY_REQUEST_KINDS.includes(r.kind)).length,
    },
    bootstrap: {
      state: bootstrap.closedAt ? 'closed' : bootstrap.openedAt ? 'open' : 'never_opened',
      openedAt: bootstrap.openedAt,
      closedAt: bootstrap.closedAt,
      reason: bootstrap.reason,
      approved: bootstrap.approved,
    },
    officialAutoApprovalEnabled: isOfficialAutoApprovalEnabled(),
    officialLoaderAccount: OFFICIAL_CATALOG_LOADER_ACCOUNT,
    termsVersion: publisherTermsVersion(),
    resignJobs: (await pendingResignJobs()).map((j) => ({ scope: j.scope, id: j.id, reason: j.reason, done: j.done.length, createdAt: j.createdAt })),
  };
}

const STATUS_FILTERS: Record<string, PublishRequestStatus[]> = {
  open: OPEN_STATUSES,
  pending: ['pending'],
  pending_second_approval: ['pending_second_approval'],
  approved: ['approved'],
  auto: ['approved'],
  rejected: ['rejected'],
  withdrawn: ['withdrawn'],
  decided: ['approved', 'rejected', 'withdrawn'],
};

/** Queue items for `rows`, with each row's conflict of interest for THIS manager (probes shared per org). */
async function queueItems(moderator: Caller, rows: PluginPublishRequest[], deep: boolean) {
  const pubs = new Map<string, Publisher | null>();
  const names = new Map<string, string | null>();
  const cache = new Map<string, boolean | undefined>();
  const out = [];
  for (const r of rows) {
    if (!pubs.has(r.publisherId)) pubs.set(r.publisherId, await publishers.byId(r.publisherId));
    if (r.listingId && !names.has(r.listingId)) names.set(r.listingId, (await listings.byId(r.listingId))?.name ?? null);
    const publisher = pubs.get(r.publisherId) ?? null;
    const open = OPEN_STATUSES.includes(r.status);
    const conflict = open ? await conflictOfInterest(moderator, r, publisher, { deep, cache }) : { conflict: false, reason: null };
    out.push(queueItemView(r, publisher, r.listingId ? names.get(r.listingId) ?? null : null, conflict));
  }
  return out;
}

/** A decided / updated request as the queue item the console renders. */
export async function asQueueItem(moderator: Caller, row: PluginPublishRequest) {
  return (await queueItems(moderator, [row], false))[0]!;
}

/** GET /ecosystem/requests */
export async function queue(moderator: Caller, query: Record<string, unknown>) {
  const statusKey = typeof query.status === 'string' ? query.status : 'open';
  const statuses = STATUS_FILTERS[statusKey];
  if (!statuses) throw new EcosystemError(ErrorCode.VALIDATION_ERROR, `status must be one of: ${Object.keys(STATUS_FILTERS).join(', ')}`);
  const kinds = typeof query.kind === 'string' && query.kind ? [query.kind as PublishRequestKind] : undefined;
  const lane = query.lane === 'security' || query.lane === 'standard' ? query.lane : undefined;
  const limit = Math.min(500, Math.max(1, Number.parseInt(String(query.limit ?? '200'), 10) || 200));
  const rows = await requests.list({ statuses, ...(kinds ? { kinds } : {}), ...(lane ? { lane } : {}), limit, autoOnly: statusKey === 'auto' });
  // Oldest first for the open queue (SLA order); newest first for history.
  if (statusKey === 'open' || statusKey === 'pending' || statusKey === 'pending_second_approval') rows.reverse();
  // Only the requests THIS manager could act on need the membership probes.
  return queueItems(moderator, rows, OPEN_STATUSES.some((s) => statuses.includes(s)));
}

/** GET /ecosystem/requests/:id */
export async function requestDetail(moderator: Caller, id: string) {
  const r = await requests.byId(id);
  if (!r) throw new EcosystemError(ErrorCode.NOT_FOUND, 'Request not found');
  const publisher = await publishers.byId(r.publisherId);
  if (!publisher) throw new EcosystemError(ErrorCode.NOT_FOUND, 'Publisher not found');
  const plugin = r.pluginId ? await plugins.byId(r.pluginId) : null;
  const listingName = r.listingId ? (await listings.byId(r.listingId))?.name ?? null : null;
  const conflict = OPEN_STATUSES.includes(r.status)
    ? await conflictOfInterest(moderator, r, publisher, { deep: true, plugin: publisher.ownerOrgId === SYSTEM_ORG_ID ? plugin : null })
    : { conflict: false, reason: null };
  const open = OPEN_STATUSES.includes(r.status);
  return {
    request: queueItemView(r, publisher, listingName, conflict),
    review: await reviewDiff(r, publisher),
    // Only an open request can still be decided, so only it has approvers / a live eligibility check.
    approvers: open ? await requestApprovers(r, publisher) : null,
    eligibility: open && r.kind === 'verify' ? await checkVerifiedEligibility(publisher.ownerOrgId ?? '') : null,
    advisory: r.kind === 'advisory' ? await requestAdvisory(r) : null,
    // An anonymous submission's gate report, heuristics and diff vs the previous approved version (§3.0.2).
    submission: r.kind === 'submission' ? await submissionReview(r) : null,
    // A community-listing claim: whether the claimer's verified email submitted it (E10; null = unknown).
    claimEmailMatch: r.kind === 'claim' ? await claimEmailMatch(r) : null,
  };
}

/** The advisory draft an `advisory` request carries (W8), as the console shows it. */
async function requestAdvisory(r: { payload: Record<string, unknown> | null }) {
  const id = r.payload?.advisoryId;
  const advisory = typeof id === 'string' ? await advisoryStore.byId(id) : null;
  return advisory ? (await advisoryViews([advisory]))[0] ?? null : null;
}

// -----------------------------------------------------------------------------
// Two-person system actions
// -----------------------------------------------------------------------------

/**
 * Open a system-org two-person action: stored as a `moderation` request the
 * initiating manager has ALREADY approved once, so it needs exactly one more,
 * different manager (second-approve). N28 to the other managers.
 */
async function openModeration(moderator: Caller, publisher: Publisher, action: string, extra: { listing?: PluginListing; version?: string; reason?: string | null }) {
  const name = `${action}:${extra.listing?.id ?? publisher.id}${extra.version ? `@${extra.version}` : ''}`;
  const duplicate = (await requests.list({ publisherId: publisher.id, statuses: OPEN_STATUSES, kinds: ['moderation'] }))
    .find((r) => r.payload?.name === name);
  if (duplicate) throw new EcosystemError(ErrorCode.DUPLICATE_ENTRY, 'That action is already waiting for a second approval.', { requestId: duplicate.id });
  const r = await requests.insert({
    publisherId: publisher.id,
    listingId: extra.listing?.id ?? null,
    version: extra.version ?? null,
    kind: 'moderation',
    status: 'pending_second_approval',
    firstApprovedBy: moderator.userId,
    submittedBy: moderator.userId,
    submittedOrgId: SYSTEM_ORG_ID,
    reason: extra.reason ?? null,
    payload: { name, action, submitter: { principalType: moderator.principalType } },
  });
  audit(moderator, 'plugin.request.submit', publisher.ownerOrgId, 'plugin-publish-request', r.id, { kind: 'moderation', action });
  audit(moderator, 'plugin.request.approve', publisher.ownerOrgId, 'plugin-publish-request', r.id, { kind: 'moderation', action, firstOfTwo: true });
  const title = `${publisher.handle}${extra.listing ? `/${extra.listing.name}` : ''}${extra.version ? ` ${extra.version}` : ''} — ${action.replace(/_/g, ' ')}`;
  await notifySecondApprovalNeeded({ title, firstApprover: moderator.userId, submittedOrgId: null, permission: action === 'unsuspend_publisher' || action === 'tier_verified' ? 'publishers:verify' : 'plugins:moderate' });
  return queueItemView(r, publisher, extra.listing?.name ?? null, { conflict: true, reason: 'You gave the first approval; a different manager must give the second.' });
}

// -----------------------------------------------------------------------------
// Publishers
// -----------------------------------------------------------------------------

/** GET /ecosystem/publishers */
export async function listPublishers(query: Record<string, unknown>) {
  const rows = await publishers.list({
    ...(typeof query.tier === 'string' && query.tier ? { tier: query.tier } : {}),
    ...(query.suspended === 'true' ? { suspended: true } : query.suspended === 'false' ? { suspended: false } : {}),
  });
  const q = typeof query.q === 'string' ? query.q.trim().toLowerCase() : '';
  const filtered = q ? rows.filter((p) => p.handle.includes(q) || p.displayName.toLowerCase().includes(q)) : rows;
  const all = await listings.list();
  return filtered.map((p) => ({ ...publisherView(p), listingCount: all.filter((l) => l.publisherId === p.id).length }));
}

async function publisherOr404(id: string): Promise<Publisher> {
  const p = await publishers.byId(id);
  if (!p) throw new EcosystemError(ErrorCode.NOT_FOUND, 'Publisher not found');
  return p;
}

/** POST /ecosystem/publishers/:id/suspend — immediate; re-signs every image with the lowest trust. */
export async function suspendPublisher(moderator: Caller, id: string, body: Record<string, unknown>) {
  const reason = requireReason(body.reason);
  const p = await publisherOr404(id);
  if (p.ownerOrgId === SYSTEM_ORG_ID) throw new EcosystemError(ErrorCode.VALIDATION_ERROR, 'The Official publisher cannot be suspended; suspend or yank its listings instead.');
  if (p.suspendedAt) throw new EcosystemError(ErrorCode.CONFLICT, 'The publisher is already suspended.');
  const updated = (await publishers.update(p.id, { suspendedAt: new Date(), suspendReason: reason }))!;
  await enqueueResign('publisher', p.id, 'suspend', actor(moderator));
  await invalidateVerifyCache({}).catch(() => undefined);
  audit(moderator, 'publisher.suspend', p.ownerOrgId, 'publisher', p.id, { reason: reason.slice(0, 200) });
  await notifyModerationAction({
    publisherOrgId: p.ownerOrgId,
    subject: `Publisher suspended: ${p.handle}`,
    text: `The system org suspended the publisher ${p.handle}: ${reason}. Its listings are hidden from the directory and it can't submit requests.`,
  });
  return publisherView(updated);
}

/** POST /ecosystem/publishers/:id/unsuspend — two-person (§3.0.1). */
export async function unsuspendPublisher(moderator: Caller, id: string, body: Record<string, unknown>) {
  const p = await publisherOr404(id);
  if (!p.suspendedAt) throw new EcosystemError(ErrorCode.CONFLICT, 'The publisher is not suspended.');
  return openModeration(moderator, p, 'unsuspend_publisher', { reason: typeof body.reason === 'string' ? body.reason.slice(0, 1000) : null });
}

/** POST /ecosystem/publishers/:id/tier — to Verified: two-person; to Community: at once (with a re-sign). */
export async function setPublisherTier(moderator: Caller, id: string, body: Record<string, unknown>) {
  const reason = requireReason(body.reason);
  const p = await publisherOr404(id);
  if (p.tier === 'official' || p.tier === 'unverified') throw new EcosystemError(ErrorCode.VALIDATION_ERROR, `A ${p.tier} publisher's tier is fixed.`);
  if (body.tier === 'verified') {
    if (p.tier === 'verified') throw new EcosystemError(ErrorCode.CONFLICT, 'The publisher is already verified.');
    assertVerifiedEligible(await checkVerifiedEligibility(p.ownerOrgId ?? ''), 'decision');
    return { request: await openModeration(moderator, p, 'tier_verified', { reason }) };
  }
  if (body.tier !== 'community') throw new EcosystemError(ErrorCode.VALIDATION_ERROR, 'tier must be verified or community');
  if (p.tier === 'community') throw new EcosystemError(ErrorCode.CONFLICT, 'The publisher is already community.');
  const updated = (await publishers.update(p.id, { tier: 'community', verifiedAt: null, verifiedGraceUntil: null }))!;
  await enqueueResign('publisher', p.id, 'tier_change', actor(moderator));
  audit(moderator, 'publisher.tier.change', p.ownerOrgId, 'publisher', p.id, { from: p.tier, to: 'community', reason: reason.slice(0, 200) });
  await notifyModerationAction({
    publisherOrgId: p.ownerOrgId,
    subject: `Publisher tier changed: ${p.handle} is now Community`,
    text: `The system org changed ${p.handle} from Verified to Community: ${reason}.`,
  });
  return { publisher: publisherView(updated) };
}

// -----------------------------------------------------------------------------
// Listings
// -----------------------------------------------------------------------------

/** GET /ecosystem/listings */
export async function listListings(query: Record<string, unknown>) {
  const rows = await listings.list({
    ...(typeof query.state === 'string' && query.state ? { state: query.state } : {}),
    ...(typeof query.publisherId === 'string' && query.publisherId ? { publisherId: query.publisherId } : {}),
  });
  const q = typeof query.q === 'string' ? query.q.trim().toLowerCase() : '';
  const filtered = (q ? rows.filter((l) => l.name.includes(q) || (l.summary ?? '').toLowerCase().includes(q)) : rows).slice(0, 500);
  const vs = await versions.forListings(filtered.map((l) => l.id));
  const stats = new Map((await listingStats.byListings(filtered.map((l) => l.id))).map((s) => [s.listingId, s]));
  const pubs = new Map<string, Publisher | null>();
  for (const pid of new Set(filtered.map((l) => l.publisherId))) pubs.set(pid, await publishers.byId(pid));
  return filtered.map((l) => listingView(l, pubs.get(l.publisherId) ?? null, {
    versions: vs.filter((v) => v.listingId === l.id),
    stats: stats.get(l.id) ?? null,
  }));
}

async function listingOr404(id: string): Promise<{ listing: PluginListing; publisher: Publisher }> {
  const listing = await listings.byId(id);
  if (!listing) throw new EcosystemError(ErrorCode.NOT_FOUND, 'Listing not found');
  return { listing, publisher: await publisherOr404(listing.publisherId) };
}

/**
 * POST /ecosystem/listings/:id/state — `unmaintained` / `suspended` / `listed`.
 * Lifting a suspension is two-person; everything else applies at once.
 */
export async function setListingState(moderator: Caller, id: string, body: Record<string, unknown>) {
  const reason = requireReason(body.reason);
  const { listing, publisher } = await listingOr404(id);
  const state = body.state;
  if (state !== 'listed' && state !== 'unmaintained' && state !== 'suspended') {
    throw new EcosystemError(ErrorCode.VALIDATION_ERROR, 'state must be listed, unmaintained or suspended');
  }
  if (listing.state === state) throw new EcosystemError(ErrorCode.CONFLICT, `The listing is already ${state}.`);
  if (listing.state === 'transferred') throw new EcosystemError(ErrorCode.CONFLICT, 'A transferred listing cannot change state.');
  if (listing.state === 'suspended' && state === 'listed') {
    return { request: await openModeration(moderator, publisher, 'relist', { listing, reason }) };
  }
  const updated = (await listings.update(listing.id, { state }))!;
  if (state === 'suspended') {
    for (const v of await versions.forListings([listing.id])) {
      if (v.imageRepository) await invalidateVerifyCache({ imageRepository: v.imageRepository }).catch(() => undefined);
    }
  }
  audit(moderator, 'plugin.listing.state.change', publisher.ownerOrgId, 'plugin-listing', listing.id, { listing: `${publisher.handle}/${listing.name}`, from: listing.state, to: state, reason: reason.slice(0, 200) });
  // N8 to the publisher and to THIS listing's installers (not the publisher's
  // other listings); unmaintained also tells those installers to plan a
  // replacement (N14).
  await notifyModerationAction({
    publisherOrgId: publisher.ownerOrgId,
    subject: `Listing ${state}: ${publisher.handle}/${listing.name}`,
    text: `The system org marked ${publisher.handle}/${listing.name} as ${state}: ${reason}.`,
    listing: updated,
  });
  if (state === 'unmaintained') await notifyListingUnmaintained(publisher, updated, reason).catch(() => 0);
  return { listing: listingView(updated, publisher) };
}

/** POST /ecosystem/listings/:id/versions/:version/yank — immediate. */
export async function yankVersion(moderator: Caller, id: string, version: string, body: Record<string, unknown>) {
  const reason = requireReason(body.reason);
  const { listing, publisher } = await listingOr404(id);
  await yankListedVersion(listing, publisher, version, reason, actor(moderator));
  const fresh = (await listings.byId(listing.id))!;
  return listingView(fresh, publisher, { versions: await versions.forListings([listing.id]) });
}

/** POST /ecosystem/listings/:id/versions/:version/unyank — two-person. */
export async function unyankVersion(moderator: Caller, id: string, version: string, body: Record<string, unknown>) {
  const reason = requireReason(body.reason);
  const { listing, publisher } = await listingOr404(id);
  const v = await versions.get(listing.id, version);
  if (!v) throw new EcosystemError(ErrorCode.NOT_FOUND, 'Version not found');
  if (!v.yankedAt) throw new EcosystemError(ErrorCode.CONFLICT, `${version} is not yanked.`);
  return openModeration(moderator, publisher, 'unyank', { listing, version, reason });
}

/**
 * POST /ecosystem/resign — queue a re-sign of EVERY published image (one job per
 * publisher with listings), e.g. after the plugin-signing key was rotated
 * (docs/runbooks/secret-rotation.md): a rotation re-signs nothing in `public/*`
 * by itself. The job is idempotent and resumable (resign.ts).
 */
export async function resignAll(moderator: Caller, body: Record<string, unknown>) {
  const reason = requireReason(body.reason);
  const withListings = new Set((await listings.list()).map((l) => l.publisherId));
  for (const publisherId of withListings) await enqueueResign('publisher', publisherId, 'operator', actor(moderator));
  audit(moderator, 'registry.image.resign', null, 'publisher', 'all', { publishers: withListings.size, reason: reason.slice(0, 200) });
  return { queued: withListings.size };
}

// -----------------------------------------------------------------------------
// Auto-approval rules
// -----------------------------------------------------------------------------

const TIERS = ['official', 'verified', 'community', 'unverified'] as const;
export const AutoRuleConditionsSchema = z.object({
  requestKinds: z.array(z.enum(['new_version', 'listing_update'])).min(1),
  publisherTiers: z.array(z.enum(TIERS)).min(1),
  bumps: z.array(z.enum(['patch', 'minor'])).default([]),
  submitterServiceAccount: z.string().max(64).optional(),
  textOnlyListingUpdates: z.boolean().optional(),
  maxPerListingPerDay: z.number().int().min(0).max(1000).optional(),
  maxPerDay: z.number().int().min(0).max(100_000).optional(),
  instanceFlag: z.literal('OFFICIAL_AUTO_APPROVAL_ENABLED').optional(),
  seeded: z.string().max(64).optional(),
}).strict();

function parseConditions(raw: unknown): AutoRuleConditions {
  const parsed = AutoRuleConditionsSchema.safeParse(raw);
  if (!parsed.success) {
    throw new EcosystemError(ErrorCode.VALIDATION_ERROR, `Invalid conditions: ${parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}`);
  }
  return parsed.data as AutoRuleConditions;
}

function parseName(raw: unknown): string {
  if (typeof raw !== 'string' || raw.trim() === '' || raw.length > 255) throw new EcosystemError(ErrorCode.VALIDATION_ERROR, 'name is required (at most 255 characters)');
  return raw.trim();
}

async function ruleViewOf(r: EcosystemAutoApprovalRule) {
  const since = new Date(Date.now() - 24 * 3_600_000);
  const conditions = (r.conditions ?? {}) as AutoRuleConditions;
  return ruleView(r, { approvedToday: (await requests.autoApprovedSince(r.id, since)).length, flagDisabled: !ruleFlagOn(conditions) });
}

/** GET /ecosystem/rules */
export async function listRules() {
  return Promise.all((await rules.list()).map(ruleViewOf));
}

/** POST /ecosystem/rules — created DISABLED with its enable pending a second manager. */
export async function createRule(moderator: Caller, body: Record<string, unknown>) {
  const name = parseName(body.name);
  const conditions = parseConditions(body.conditions);
  const r = await rules.insert({
    name,
    enabled: false,
    conditions: conditions as Record<string, unknown>,
    createdBy: moderator.userId,
    pendingChange: { requestedBy: moderator.userId, requestedAt: new Date().toISOString(), enabled: true, name, conditions: conditions as Record<string, unknown> },
  });
  audit(moderator, 'ecosystem.auto-approval-rule.create', null, 'auto-approval-rule', r.id, { name, pending: true });
  return ruleViewOf(r);
}

async function ruleOr404(id: string): Promise<EcosystemAutoApprovalRule> {
  const r = await rules.byId(id);
  if (!r) throw new EcosystemError(ErrorCode.NOT_FOUND, 'Rule not found');
  return r;
}

/**
 * PATCH /ecosystem/rules/:id — a narrowing (disable, rename, tighter
 * conditions) applies at once; enabling or widening becomes the rule's
 * `pendingChange`, applied by a second manager.
 */
export async function updateRule(moderator: Caller, id: string, body: Record<string, unknown>) {
  const rule = await ruleOr404(id);
  const name = body.name !== undefined ? parseName(body.name) : rule.name;
  const conditions = body.conditions !== undefined ? parseConditions(body.conditions) : (rule.conditions as AutoRuleConditions);
  const enabled = typeof body.enabled === 'boolean' ? body.enabled : rule.enabled;
  const widening = (enabled && !rule.enabled) || widensRule(rule.conditions as AutoRuleConditions, conditions);
  if (widening) {
    const updated = (await rules.update(rule.id, {
      ...(name !== rule.name ? { name } : {}),
      pendingChange: { requestedBy: moderator.userId, requestedAt: new Date().toISOString(), enabled, name, conditions: conditions as Record<string, unknown> },
    }))!;
    audit(moderator, 'ecosystem.auto-approval-rule.update', null, 'auto-approval-rule', rule.id, { pending: true, enabling: enabled && !rule.enabled });
    return ruleViewOf(updated);
  }
  const updated = (await rules.update(rule.id, { name, enabled, conditions: conditions as Record<string, unknown> }))!;
  audit(moderator, 'ecosystem.auto-approval-rule.update', null, 'auto-approval-rule', rule.id, { enabled, narrowed: true });
  return ruleViewOf(updated);
}

/** POST /ecosystem/rules/:id/approve-change — the second manager applies a pending enable/widening. */
export async function approveRuleChange(moderator: Caller, id: string) {
  const rule = await ruleOr404(id);
  const change = rule.pendingChange;
  if (!change) throw new EcosystemError(ErrorCode.CONFLICT, 'The rule has no pending change.');
  if (change.requestedBy === moderator.userId) {
    throw new EcosystemError(ErrorCode.SEPARATION_OF_DUTIES, 'A different manager must approve a change you proposed.');
  }
  const updated = (await rules.update(rule.id, {
    name: change.name, enabled: change.enabled, conditions: change.conditions, approvedBy: moderator.userId, pendingChange: null,
  }))!;
  audit(moderator, 'ecosystem.auto-approval-rule.update', null, 'auto-approval-rule', rule.id, { secondApproval: true, proposedBy: change.requestedBy, enabled: change.enabled });
  return ruleViewOf(updated);
}

/** DELETE /ecosystem/rules/:id — removing a rule only narrows (at once). */
export async function deleteRule(moderator: Caller, id: string) {
  const rule = await ruleOr404(id);
  // Requests keep their autoRuleId history: detach, never cascade.
  for (const r of await requests.autoApprovedSince(rule.id, new Date(0))) await requests.transition(r.id, r.status, { autoRuleId: null, payload: { ...r.payload, autoRuleName: rule.name } });
  await rules.remove(rule.id);
  audit(moderator, 'ecosystem.auto-approval-rule.delete', null, 'auto-approval-rule', rule.id, { name: rule.name });
  return { deleted: true };
}

// -----------------------------------------------------------------------------
// Reserved names
// -----------------------------------------------------------------------------

/** GET /ecosystem/reserved-names */
export async function listReserved() {
  return (await reservedNames.list()).map((n) => ({ name: n.name, reason: n.reason, publisherId: n.publisherId, createdAt: new Date(n.createdAt).toISOString() }));
}

/** PUT /ecosystem/reserved-names/:name */
export async function putReserved(moderator: Caller, name: string, body: Record<string, unknown>) {
  const n = name.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{0,254}$/.test(n)) throw new EcosystemError(ErrorCode.VALIDATION_ERROR, 'name must be a lowercase handle or plugin name');
  const publisherId = typeof body.publisherId === 'string' && body.publisherId ? body.publisherId : null;
  if (publisherId) await publisherOr404(publisherId);
  const row = await reservedNames.put(n, typeof body.reason === 'string' ? body.reason.slice(0, 500) : null, publisherId);
  audit(moderator, 'ecosystem.reserved-name.update', null, 'reserved-name', n, { op: 'put', publisherId });
  return { name: row.name, reason: row.reason, publisherId: row.publisherId };
}

/** DELETE /ecosystem/reserved-names/:name */
export async function deleteReserved(moderator: Caller, name: string) {
  const removed = await reservedNames.remove(name.trim().toLowerCase());
  if (!removed) throw new EcosystemError(ErrorCode.NOT_FOUND, 'Reserved name not found');
  audit(moderator, 'ecosystem.reserved-name.update', null, 'reserved-name', name, { op: 'delete' });
  return { deleted: true };
}
