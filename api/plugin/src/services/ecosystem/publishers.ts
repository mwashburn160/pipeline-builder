// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tenant publishers (docs/plans/plugin-ecosystem.md §3.1, §3.6, §3.7, W1):
 * one publisher per ROOT org — a handle claimed against a reserved list,
 * versioned terms acceptance, the description/homepage the publisher edits
 * directly (post-moderated), its own listings, and pausing them (D14). Handle
 * and display-name changes, transfers and the Verified application are
 * REQUESTS (see requests.ts), decided by the system org.
 */

import {
  actorId,
  BUILTIN_RESERVED_HANDLES,
  ErrorCode,
  getQuotaServiceAuthHeader,
  isPluginPublishingEnabled,
  projectUrlProblem,
  publisherHandleProblem,
  publisherTermsVersion,
  SYSTEM_ORG_ID,
} from '@pipeline-builder/api-core';
import { OFFICIAL_PUBLISHER_HANDLE, type Publisher } from '@pipeline-builder/pipeline-data';

import { can, ecosystemDeps, EcosystemError, type Caller } from './context.js';
import { notifyListingPaused } from './install-notify.js';
import { listingStats } from './reviews-store.js';
import { requests as requestStore, listings, publishers, reservedNames, versions, OPEN_STATUSES } from './store.js';
import { listingView, publisherView } from './views.js';
import { emitPluginAudit } from '../audit.js';

/** Publisher display-name / description caps (mirror the columns). */
export const DISPLAY_NAME_MAX = 255;
export const DESCRIPTION_MAX = 2000;

/**
 * Why `handle` can't be claimed by `forPublisherId` (null = a new publisher):
 * shape, the built-in reserved words, and the system org's reserved-name list
 * (a name reserved FOR a publisher is claimable by that publisher only).
 * Returns `{ code, message }` or null when the handle is free to claim.
 */
export async function handleRefusal(handle: string, forPublisherId: string | null): Promise<{ code: ErrorCode; message: string } | null> {
  const problem = publisherHandleProblem(handle);
  if (problem) return { code: ErrorCode.VALIDATION_ERROR, message: `Invalid handle: ${problem}` };
  if (BUILTIN_RESERVED_HANDLES.includes(handle)) {
    return { code: ErrorCode.PUBLISHER_HANDLE_RESERVED, message: `The handle "${handle}" is reserved.` };
  }
  const reserved = await reservedNames.get(handle);
  // A name reserved for nobody refuses everyone; one reserved FOR a publisher
  // is claimable by that publisher alone.
  if (reserved && (reserved.publisherId === null || reserved.publisherId !== forPublisherId)) {
    return {
      code: ErrorCode.PUBLISHER_HANDLE_RESERVED,
      message: `The handle "${handle}" is reserved${reserved.reason ? ` (${reserved.reason})` : ''}. Submit a claim request if it belongs to you.`,
    };
  }
  const taken = await publishers.byHandle(handle);
  if (taken && taken.id !== forPublisherId) return { code: ErrorCode.DUPLICATE_ENTRY, message: `The handle "${handle}" is taken.` };
  return null;
}

/** The org's listings-quota standing: live listings vs the plan limit (-1 = unlimited). */
export async function listingsQuota(orgId: string, publisherId: string | null): Promise<{ used: number; limit: number }> {
  const used = publisherId ? await listings.countActive(publisherId) : 0;
  if (orgId === SYSTEM_ORG_ID) return { used, limit: -1 };
  const result = await ecosystemDeps().quotaService.check(orgId, 'listings', getQuotaServiceAuthHeader(orgId));
  return { used, limit: result.unlimited ? -1 : result.limit };
}

/** Whether the caller's org may apply for Verified (feature `verified_publisher`, Team+ — §3.7). */
export function verifiedEligible(caller: Caller): boolean {
  return caller.isSuperAdmin || caller.features.includes('verified_publisher');
}

/** Whether `publisher` has accepted the terms version in force (the Official publisher never needs to). */
export function termsAccepted(publisher: Pick<Publisher, 'handle' | 'termsVersion'> | null): boolean {
  if (!publisher) return false;
  return publisher.handle === OFFICIAL_PUBLISHER_HANDLE || publisher.termsVersion === publisherTermsVersion();
}

/** Refuse a caller acting for a publisher from a team org (§3.1, G33). */
export function assertRootOrg(caller: Caller): void {
  if (caller.parentOrgId) {
    throw new EcosystemError(ErrorCode.PUBLISHER_ROOT_ORG_REQUIRED,
      'Publishing is done from your root organization. Switch to it, or move the plugin there.');
  }
}

/** GET /plugins/publisher — the caller org's publisher and its publishing standing. */
export async function publisherState(caller: Caller) {
  const publisher = await publishers.byOrg(caller.orgId);
  return {
    publisher: publisher ? publisherView(publisher) : null,
    isRootOrg: !caller.parentOrgId,
    terms: { currentVersion: publisherTermsVersion(), accepted: termsAccepted(publisher) },
    verifiedEligible: verifiedEligible(caller),
    listingsQuota: await listingsQuota(caller.orgId, publisher?.id ?? null),
    publishingEnabled: caller.orgId === SYSTEM_ORG_ID || isPluginPublishingEnabled(),
  };
}

function optionalUrl(value: unknown, field: string): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string') throw new EcosystemError(ErrorCode.VALIDATION_ERROR, `${field} must be a string`);
  const problem = projectUrlProblem(value);
  if (problem) throw new EcosystemError(ErrorCode.VALIDATION_ERROR, `${field} ${problem}`);
  return value;
}

function optionalText(value: unknown, field: string, max: number): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw new EcosystemError(ErrorCode.VALIDATION_ERROR, `${field} must be a string`);
  const t = value.trim();
  if (t.length > max) throw new EcosystemError(ErrorCode.VALIDATION_ERROR, `${field} must be at most ${max} characters`);
  return t === '' ? null : t;
}

/** Validate a display name (required, trimmed, capped). */
export function displayNameOf(value: unknown): string {
  const name = optionalText(value, 'displayName', DISPLAY_NAME_MAX);
  if (!name) throw new EcosystemError(ErrorCode.VALIDATION_ERROR, 'displayName is required');
  return name;
}

/**
 * POST /plugins/publisher — claim a handle and accept the terms. One publisher
 * per root org; tier Community until the system org says otherwise.
 */
export async function claimPublisher(caller: Caller, body: Record<string, unknown>) {
  assertRootOrg(caller);
  if (await publishers.byOrg(caller.orgId)) throw new EcosystemError(ErrorCode.DUPLICATE_ENTRY, 'Your organization already has a publisher.');
  const handle = typeof body.handle === 'string' ? body.handle.trim().toLowerCase() : '';
  const displayName = displayNameOf(body.displayName);
  const description = optionalText(body.description, 'description', DESCRIPTION_MAX);
  const homepageUrl = optionalUrl(body.homepageUrl, 'homepageUrl');
  if (body.termsVersion !== publisherTermsVersion()) {
    throw new EcosystemError(ErrorCode.PUBLISHER_TERMS_REQUIRED, `Accept the current publisher terms (version ${publisherTermsVersion()}).`);
  }
  const refusal = await handleRefusal(handle, null);
  if (refusal) throw new EcosystemError(refusal.code, refusal.message);

  const now = new Date();
  const publisher = await publishers.insert({
    ownerOrgId: caller.orgId,
    handle,
    displayName,
    description,
    homepageUrl,
    tier: 'community',
    termsVersion: publisherTermsVersion(),
    termsAcceptedAt: now,
  });
  const base = { actorId: actorId({ userId: caller.userId }), orgId: caller.orgId, targetType: 'publisher', targetId: publisher.id };
  emitPluginAudit({ ...base, action: 'publisher.create', details: { handle, tier: 'community' } });
  emitPluginAudit({ ...base, action: 'publisher.terms.accept', details: { termsVersion: publisherTermsVersion() } });
  return publisherView(publisher);
}

/** The caller org's publisher, or 409 PUBLISHER_REQUIRED. */
export async function ownPublisher(caller: Caller): Promise<Publisher> {
  const publisher = await publishers.byOrg(caller.orgId);
  if (!publisher) throw new EcosystemError(ErrorCode.PUBLISHER_REQUIRED, 'Create your publisher profile first.');
  return publisher;
}

/** PATCH /plugins/publisher — description and homepage (post-moderated, §5a). Handle/name changes are requests. */
export async function updatePublisherProfile(caller: Caller, body: Record<string, unknown>) {
  assertRootOrg(caller);
  const publisher = await ownPublisher(caller);
  if ('handle' in body || 'displayName' in body) {
    throw new EcosystemError(ErrorCode.VALIDATION_ERROR, 'Handle and display-name changes are decided by the system org: submit a profile_change request.');
  }
  const patch: Partial<Publisher> = {};
  if ('description' in body) patch.description = optionalText(body.description, 'description', DESCRIPTION_MAX);
  if ('homepageUrl' in body) patch.homepageUrl = optionalUrl(body.homepageUrl, 'homepageUrl');
  if (Object.keys(patch).length === 0) throw new EcosystemError(ErrorCode.VALIDATION_ERROR, 'Nothing to update');
  const updated = (await publishers.update(publisher.id, patch))!;
  emitPluginAudit({
    action: 'publisher.update',
    actorId: actorId({ userId: caller.userId }),
    orgId: caller.orgId,
    targetType: 'publisher',
    targetId: publisher.id,
    details: { fields: Object.keys(patch) },
  });
  return publisherView(updated);
}

/** POST /plugins/publisher/terms — accept the terms version in force. */
export async function acceptTerms(caller: Caller, termsVersion: unknown) {
  assertRootOrg(caller);
  const publisher = await ownPublisher(caller);
  if (termsVersion !== publisherTermsVersion()) {
    throw new EcosystemError(ErrorCode.VALIDATION_ERROR, `The current publisher terms version is ${publisherTermsVersion()}.`);
  }
  const updated = (await publishers.update(publisher.id, { termsVersion: publisherTermsVersion(), termsAcceptedAt: new Date() }))!;
  emitPluginAudit({
    action: 'publisher.terms.accept',
    actorId: actorId({ userId: caller.userId }),
    orgId: caller.orgId,
    targetType: 'publisher',
    targetId: publisher.id,
    details: { termsVersion: publisherTermsVersion() },
  });
  return publisherView(updated);
}

/** GET /plugins/publisher/listings — the org's listings, each with its versions and open-request count. */
export async function ownListings(caller: Caller) {
  const publisher = await publishers.byOrg(caller.orgId);
  if (!publisher) return [];
  const rows = await listings.list({ publisherId: publisher.id });
  const allVersions = await versions.forListings(rows.map((l) => l.id));
  const open = await requestStore.list({ publisherId: publisher.id, statuses: OPEN_STATUSES });
  const stats = new Map((await listingStats.byListings(rows.map((l) => l.id))).map((s) => [s.listingId, s]));
  return rows.map((l) => listingView(l, publisher, {
    versions: allVersions.filter((v) => v.listingId === l.id),
    openRequests: open.filter((r) => r.listingId === l.id).length,
    stats: stats.get(l.id) ?? null,
  }));
}

/**
 * POST /plugins/publisher/listings/:id/pause — the publisher pauses its own
 * listing (no new installs) or one version (hidden from new resolution), at once
 * and without review (D14): it only narrows its own reach. Unpausing is a request.
 */
export async function pause(caller: Caller, listingId: string, version: string | undefined) {
  assertRootOrg(caller);
  if (!can(caller, 'plugins:publish')) throw new EcosystemError(ErrorCode.INSUFFICIENT_PERMISSIONS, 'Pausing needs plugins:publish');
  const publisher = await ownPublisher(caller);
  const listing = await listings.byId(listingId);
  if (!listing || listing.publisherId !== publisher.id) throw new EcosystemError(ErrorCode.NOT_FOUND, 'Listing not found');
  const now = new Date();
  const base = { actorId: actorId({ userId: caller.userId }), orgId: caller.orgId, affectedOrgId: caller.orgId };
  if (version) {
    const v = await versions.get(listing.id, version);
    if (!v) throw new EcosystemError(ErrorCode.NOT_FOUND, 'Version not found');
    if (!v.pausedAt) await versions.update(v.id, { pausedAt: now });
    emitPluginAudit({ ...base, action: 'plugin.version.pause', targetType: 'plugin-listing-version', targetId: v.id, details: { listing: listing.name, version } });
  } else {
    if (!listing.pausedAt) await listings.update(listing.id, { pausedAt: now });
    emitPluginAudit({ ...base, action: 'plugin.listing.pause', targetType: 'plugin-listing', targetId: listing.id, details: { listing: listing.name } });
  }
  // N26: the installing orgs are told (in-app); their installs keep resolving.
  const fresh = (await listings.byId(listing.id))!;
  await notifyListingPaused(publisher, fresh, version);
  return listingView(fresh, publisher, { versions: await versions.forListings([listing.id]) });
}

/**
 * Keep the Official publisher pointed at THIS instance's system org (the SQL
 * seed uses the default id; SYSTEM_ORG_ID may differ) — and create it when an
 * install predates the seed. Idempotent; run at boot.
 */
export async function ensureOfficialPublisher(): Promise<Publisher> {
  const existing = await publishers.byHandle(OFFICIAL_PUBLISHER_HANDLE);
  if (!existing) {
    return publishers.insert({
      handle: OFFICIAL_PUBLISHER_HANDLE,
      ownerOrgId: SYSTEM_ORG_ID,
      displayName: 'Pipeline Builder',
      description: 'The Official plugin catalog, maintained with the platform.',
      tier: 'official',
      verifiedAt: new Date(),
    });
  }
  if (existing.ownerOrgId !== SYSTEM_ORG_ID || existing.tier !== 'official') {
    return (await publishers.update(existing.id, { ownerOrgId: SYSTEM_ORG_ID, tier: 'official' }))!;
  }
  return existing;
}
