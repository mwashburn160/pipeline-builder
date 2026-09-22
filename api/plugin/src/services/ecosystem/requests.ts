// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The tenant side of the publish-request queue (docs/plugin-publishing.md
 * ): a publisher SUBMITS requests — nothing
 * a tenant does alone puts anything in the directory — and can withdraw them.
 *
 *  - A version request (new_listing / new_version) needs a `public` version
 *    with a license, a README and a passing vulnerability gate. Its image
 *    digest is PINNED at submit and the version is FROZEN:
 *    approval publishes exactly that digest or fails closed.
 *  - The `listings` quota is checked at submit (and again at approval):
 *    a new listing needs room under the plan's limit; a publisher OVER its
 *    limit after a downgrade may only use the security-fix lane.
 *  - A new listing carries the accept-or-edit metadata (pre-filled from
 *    the version's effective metadata, with provenance).
 *  - After submitting, the bootstrap exception or an auto-approval rule may
 *    decide it on the spot (decisions.ts).
 */

import {
  actorId,
  ErrorCode,
  findConfusableName,
  isPluginPublishingEnabled,
  isSystemOrgId,
  parseCatalogEdits,
  PLUGIN_CATALOG_FIELDS,
  PUBLISH_PERMISSION_REQUEST_KINDS,
  publisherTermsVersion,
  SYSTEM_ORG_ID,
  TENANT_REQUEST_KINDS,
  type Permission,
  type PluginCatalogEdits,
  parsePage,
} from '@pipeline-builder/api-core';
import {
  isUniqueViolation,
  OFFICIAL_PUBLISHER_HANDLE,
  type PluginListing,
  type PluginPublishRequest,
  type PluginPublishRequestInsert,
  type Publisher,
  type PublishRequestKind,
} from '@pipeline-builder/pipeline-data';

import { advisoryStore } from './advisories-store.js';
import { buildPublisherDraft, discardDraft, removeDraft } from './advisories.js';
import { ecosystemAudit } from './audit.js';
import { autoDecide } from './auto-approval.js';
import { can, EcosystemError, submitterTag, type Caller } from './context.js';
import { releaseFreeze } from './decisions.js';
import {
  applyEdits, effectiveMetadata, LISTING_FIELDS, listingFieldValue, listingUpdateOffer, parseSources, type RequestMetadata,
} from './metadata.js';
import { notifyRequestSubmitted, notifyTransferRequested, notifyTransferUpdate, requestTitle } from './notify.js';
import { requiredDecisionPermission, sameValue, versionBump, versionGates, type Gate } from './policy.js';
import {
  assertRootOrg, displayNameOf, handleRefusal, listingsQuota, ownPublisher, termsAccepted, verifiedEligible,
} from './publishers.js';
import {
  decodeRequestCursor, encodeRequestCursor, listings, OPEN_STATUSES, plugins, publishers, REQUEST_STATUS_FILTERS, requests, reservedNames, versions, type PluginRow, type RequestCursor, type RequestFilter,
} from './store.js';
import { claimantEmailHash as claimantEmailHashOf } from './submission-moderation.js';
import { topInstalledListings } from './submissions-store.js';
import { isActiveListing, optionalText, requiredText } from './util.js';
import { assertVerifiedEligible, checkVerifiedEligibility } from './verified-eligibility.js';
import { listingView, publisherView, requestView } from './views.js';
import { pluginService } from '../plugin-service.js';

type Req = PluginPublishRequest;

/** Why tenant publishing is closed to this caller, if it is. */
function assertPublishingOpen(caller: Caller): void {
  if (!isSystemOrgId(caller.orgId) && !isPluginPublishingEnabled()) {
    throw new EcosystemError(ErrorCode.PLUGIN_PUBLISHING_DISABLED, 'Publishing to the plugin ecosystem is turned off on this instance.');
  }
}

function assertPublisherActive(publisher: Publisher): void {
  if (publisher.suspendedAt) {
    throw new EcosystemError(ErrorCode.PUBLISHER_SUSPENDED, `The publisher is suspended${publisher.suspendReason ? `: ${publisher.suspendReason}` : ''}.`);
  }
  if (!termsAccepted(publisher)) {
    throw new EcosystemError(ErrorCode.PUBLISHER_TERMS_REQUIRED, 'Accept the current publisher terms before submitting new requests.');
  }
}

/** The caller's live plugin version, or 404. */
async function ownPlugin(caller: Caller, pluginId: unknown): Promise<PluginRow> {
  if (typeof pluginId !== 'string' || pluginId === '') throw new EcosystemError(ErrorCode.MISSING_REQUIRED_FIELD, 'pluginId is required');
  const plugin = await plugins.byId(pluginId, caller.orgId);
  if (!plugin) throw new EcosystemError(ErrorCode.NOT_FOUND, 'Plugin version not found in your organization');
  return plugin;
}

/** The caller's publisher's listing, or 404. */
async function ownListing(publisher: Publisher, listingId: unknown): Promise<PluginListing> {
  if (typeof listingId !== 'string' || listingId === '') throw new EcosystemError(ErrorCode.MISSING_REQUIRED_FIELD, 'listingId is required');
  const listing = await listings.byId(listingId);
  if (!listing || listing.publisherId !== publisher.id) throw new EcosystemError(ErrorCode.NOT_FOUND, 'Listing not found');
  return listing;
}


/**
 * The submit gates for a version request: the version's own gates,
 * plus the listing it would land on.
 */
async function versionRequestGates(publisher: Publisher | null, plugin: PluginRow, listing: PluginListing | null): Promise<Gate[]> {
  const gates = versionGates(plugin);
  if (listing) {
    gates.push({ id: 'listing_state', ok: isActiveListing(listing), message: isActiveListing(listing) ? 'The listing is live' : `The listing is ${listing.state}` });
    const existing = await versions.get(listing.id, plugin.version);
    gates.push({ id: 'already_listed', ok: !existing, message: existing ? `${plugin.version} is already published` : 'The version is not published yet' });
  } else if (publisher) {
    const reserved = await reservedNames.get(plugin.name);
    const blocked = !!reserved && reserved.publisherId !== publisher.id;
    // not confusable with another publisher's top listing (a typosquat of a popular plugin).
    const confusable = blocked ? null : findConfusableName(plugin.name,
      (await topInstalledListings()).filter((l) => l.publisherId !== publisher.id).map((l) => l.name));
    gates.push({
      id: 'name',
      ok: !blocked && !confusable,
      message: blocked ? `The listing name "${plugin.name}" is reserved`
        : confusable ? `The listing name "${plugin.name}" is too similar to the popular plugin "${confusable}"` : 'The listing name is available',
    });
  }
  return gates;
}

/** The listings-quota standing for a request of `kind` (open new-listing requests count toward the limit). */
async function quotaGate(publisher: Publisher, kind: string, securityLane: boolean): Promise<Gate & { used: number; limit: number }> {
  const quota = await listingsQuota(publisher.ownerOrgId ?? SYSTEM_ORG_ID, publisher.id);
  if (quota.limit === -1) return { id: 'quota', ok: true, message: 'Unlimited listings', ...quota };
  if (kind === 'new_listing') {
    const pendingNew = await requests.count({ publisherId: publisher.id, statuses: OPEN_STATUSES, kinds: ['new_listing'] });
    const ok = quota.used + pendingNew < quota.limit;
    return { id: 'quota', ok, message: ok ? `${quota.used + pendingNew} of ${quota.limit} listings used` : `The plan allows ${quota.limit} listings (${quota.used} live, ${pendingNew} pending)`, ...quota };
  }
  // Over the limit after a downgrade: updates are frozen, the security lane stays open.
  const ok = securityLane || quota.used <= quota.limit;
  return { id: 'quota', ok, message: ok ? `${quota.used} of ${quota.limit} listings used` : `Over the plan's listings limit (${quota.used}/${quota.limit}): only security fixes can be published until you are back under it`, ...quota };
}

/**
 * GET /plugins/publish-requests/draft?pluginId= — everything the request
 * form shows: the kind, the gates, the version's effective metadata (for a new
 * version: next to the live listing's values) and the changed-fields offer.
 */
export async function draft(caller: Caller, pluginId: unknown) {
  const plugin = await ownPlugin(caller, pluginId);
  const publisher = await publishers.byOrg(caller.orgId);
  const listing = publisher ? await listings.byName(publisher.id, plugin.name) : null;
  const kind = listing ? 'new_version' as const : 'new_listing' as const;
  const gates: Gate[] = [
    { id: 'publisher', ok: !!publisher && !publisher.suspendedAt, message: !publisher ? 'Create your publisher profile first' : publisher.suspendedAt ? 'The publisher is suspended' : `Publishing as ${publisher.handle}` },
    { id: 'terms', ok: termsAccepted(publisher), message: termsAccepted(publisher) ? 'Publisher terms accepted' : 'Accept the current publisher terms' },
    ...await versionRequestGates(publisher, plugin, listing),
  ];
  const quota = publisher ? await quotaGate(publisher, kind, false) : { id: 'quota', ok: true, message: 'No publisher yet', used: 0, limit: -1 };
  gates.push({ id: quota.id, ok: quota.ok, message: quota.message });
  const meta = effectiveMetadata(plugin);
  return {
    kind,
    plugin: {
      id: plugin.id,
      name: plugin.name,
      version: plugin.version,
      visibility: plugin.visibility,
      imageDigest: plugin.imageDigest,
      license: plugin.license,
      hasReadme: !!plugin.readmeHtml,
      signed: plugin.imageDigest !== null,
      scannedAt: plugin.scannedAt?.toISOString() ?? null,
      vulnCritical: plugin.vulnCritical,
      vulnHigh: plugin.vulnHigh,
      vulnCriticalFixable: plugin.vulnCriticalFixable,
      vulnHighFixable: plugin.vulnHighFixable,
      breaking: plugin.breaking === true,
    },
    listing: listing ? listingView(listing, publisher) : null,
    gates,
    metadata: PLUGIN_CATALOG_FIELDS.map((field) => ({
      field,
      value: meta.values[field] ?? null,
      source: meta.sources[field] ?? null,
      ...(listing && LISTING_FIELDS.includes(field)
        ? { current: listingFieldValue(listing, field), changed: listingUpdateOffer(plugin, listing).some((o) => o.field === field) }
        : {}),
    })),
    listingUpdateOffer: listing ? listingUpdateOffer(plugin, listing).map(({ field, value, current }) => ({ field, value, current })) : [],
    publisher: publisher ? publisherView(publisher) : null,
    listingsQuota: { used: quota.used, limit: quota.limit },
    terms: { currentVersion: publisherTermsVersion(), accepted: termsAccepted(publisher) },
  };
}

/** A security-fix advisory the request remediates, validated against the listing (the security-fix lane). */
async function securityAdvisory(advisoryId: unknown, listingId: string | null): Promise<string | null> {
  if (advisoryId === undefined || advisoryId === null || advisoryId === '') return null;
  if (typeof advisoryId !== 'string') throw new EcosystemError(ErrorCode.VALIDATION_ERROR, 'securityFixAdvisoryId must be a string');
  const advisory = await advisoryStore.byId(advisoryId);
  if (!advisory || (listingId && advisory.listingId !== listingId) || advisory.state === 'withdrawn') {
    throw new EcosystemError(ErrorCode.VALIDATION_ERROR, 'securityFixAdvisoryId does not name an advisory on this listing');
  }
  return advisory.id;
}

function assertGates(gates: Gate[]): void {
  const failing = gates.filter((g) => !g.ok);
  if (failing.length > 0) {
    throw new EcosystemError(ErrorCode.PUBLISH_GATE_FAILED, `The request can't be submitted: ${failing.map((g) => g.message).join('; ')}`, { gates: failing });
  }
}

function parseEdits(raw: unknown): PluginCatalogEdits {
  if (raw === undefined || raw === null) return {};
  const parsed = parseCatalogEdits(raw);
  if (!parsed.ok) throw new EcosystemError(ErrorCode.VALIDATION_ERROR, parsed.error, parsed.contractKeys ? { contractKeys: parsed.contractKeys } : undefined);
  return parsed.value;
}

/** What a submit produces before it is stored. */
type Draft = Omit<PluginPublishRequestInsert, 'publisherId' | 'submittedBy' | 'submittedOrgId' | 'kind'>;

/**
 * Build the request row for `kind` (per-kind validation). Throws the refusal.
 * The version kinds also FREEZE the version at the pinned digest.
 */
async function buildRequest(caller: Caller, publisher: Publisher, kind: PublishRequestKind, body: Record<string, unknown>): Promise<Draft> {
  const submitter = submitterTag(caller);
  switch (kind) {
    case 'new_listing':
    case 'new_version': {
      const plugin = await ownPlugin(caller, body.pluginId);
      const listing = await listings.byName(publisher.id, plugin.name);
      if (kind === 'new_listing' && listing) throw new EcosystemError(ErrorCode.CONFLICT, `${plugin.name} is already listed; submit a new_version request.`);
      if (kind === 'new_version' && !listing) throw new EcosystemError(ErrorCode.CONFLICT, `${plugin.name} isn't listed yet; submit a new_listing request.`);
      const advisory = await securityAdvisory(body.securityFixAdvisoryId, listing?.id ?? null);
      const gates = await versionRequestGates(publisher, plugin, listing);
      const quota = await quotaGate(publisher, kind, advisory !== null);
      if (!quota.ok) {
        throw new EcosystemError(ErrorCode.QUOTA_EXCEEDED, quota.message, { quotaType: 'listings', used: quota.used, limit: quota.limit });
      }
      assertGates(gates);
      const metadata: RequestMetadata = kind === 'new_listing' ? applyEdits(effectiveMetadata(plugin), parseEdits(body.metadata)) : effectiveMetadata(plugin);
      const bump = versionBump(listing?.latestVersion ?? null, plugin.version);
      // freeze first — a digest that moved since the caller looked fails closed.
      await pluginService.freezeVersion(caller.orgId, plugin.id, plugin.imageDigest);
      return {
        listingId: listing?.id ?? null,
        pluginId: plugin.id,
        version: plugin.version,
        digest: plugin.imageDigest,
        lane: advisory ? 'security' : 'standard',
        securityFixAdvisoryId: advisory,
        payload: {
          name: plugin.name,
          version: plugin.version,
          metadata,
          submitter,
          breaking: body.breaking === true || plugin.breaking === true || (kind === 'new_version' && bump === 'major'),
        },
      };
    }
    case 'listing_update': {
      const listing = await ownListing(publisher, body.listingId);
      if (!isActiveListing(listing)) throw new EcosystemError(ErrorCode.CONFLICT, `The listing is ${listing.state}.`);
      const edits = parseEdits(body.metadata);
      const changed = Object.fromEntries(Object.entries(edits)
        .filter(([field, value]) => LISTING_FIELDS.includes(field as never) && value !== undefined && !sameValue(value, listingFieldValue(listing, field as never))));
      if (Object.keys(changed).length === 0) throw new EcosystemError(ErrorCode.VALIDATION_ERROR, 'Nothing changes: every value matches the live listing.');
      const quota = await quotaGate(publisher, kind, false);
      if (!quota.ok) throw new EcosystemError(ErrorCode.QUOTA_EXCEEDED, quota.message, { quotaType: 'listings', used: quota.used, limit: quota.limit });
      const given = parseSources(body.sources, Object.keys(changed));
      const sources = Object.fromEntries(Object.keys(changed).map((f) => [f, given[f as never] ?? 'user']));
      return { listingId: listing.id, payload: { name: listing.name, metadata: { values: changed, sources }, submitter } };
    }
    case 'yank': {
      const listing = await ownListing(publisher, body.listingId);
      const version = requiredText(body.version, 'version', 50);
      const v = await versions.get(listing.id, version);
      if (!v) throw new EcosystemError(ErrorCode.NOT_FOUND, 'Version not found');
      if (v.yankedAt) throw new EcosystemError(ErrorCode.CONFLICT, `${version} is already yanked.`);
      const advisory = await securityAdvisory(body.securityFixAdvisoryId, listing.id);
      const reason = requiredText(body.reason, 'reason', 1000);
      return { listingId: listing.id, version, digest: v.imageDigest, reason, lane: advisory ? 'security' : 'standard', securityFixAdvisoryId: advisory, payload: { name: listing.name, reason, submitter } };
    }
    case 'unpause': {
      const listing = await ownListing(publisher, body.listingId);
      const version = optionalText(body.version, 50);
      if (version) {
        const v = await versions.get(listing.id, version);
        if (!v?.pausedAt) throw new EcosystemError(ErrorCode.CONFLICT, `${version} is not paused.`);
      } else if (!listing.pausedAt) {
        throw new EcosystemError(ErrorCode.CONFLICT, 'The listing is not paused.');
      }
      return { listingId: listing.id, version, reason: optionalText(body.reason, 1000), payload: { name: listing.name, submitter } };
    }
    case 'transfer': {
      const listing = await ownListing(publisher, body.listingId);
      const handle = requiredText((body.target as Record<string, unknown> | undefined)?.targetPublisherHandle, 'target.targetPublisherHandle', 39).toLowerCase();
      const target = await publishers.byHandle(handle);
      if (!target || !target.ownerOrgId || target.id === publisher.id) throw new EcosystemError(ErrorCode.NOT_FOUND, 'Receiving publisher not found');
      if (target.suspendedAt) throw new EcosystemError(ErrorCode.CONFLICT, 'The receiving publisher is suspended.');
      if (target.handle === OFFICIAL_PUBLISHER_HANDLE) throw new EcosystemError(ErrorCode.VALIDATION_ERROR, 'Listings can\'t be transferred to the Official publisher.');
      return {
        listingId: listing.id,
        reason: optionalText(body.reason, 1000),
        payload: { name: listing.name, submitter, transfer: { targetPublisherId: target.id, targetOrgId: target.ownerOrgId, targetHandle: target.handle, response: 'pending' } },
      };
    }
    case 'claim': {
      const target = (body.target ?? {}) as Record<string, unknown>;
      if (typeof target.handle === 'string') {
        const handle = target.handle.trim().toLowerCase();
        const refusal = await handleRefusal(handle, publisher.id);
        if (!refusal) throw new EcosystemError(ErrorCode.VALIDATION_ERROR, `The handle "${handle}" isn't reserved: request it with a profile_change instead.`);
        if (refusal.code !== ErrorCode.PUBLISHER_HANDLE_RESERVED) throw new EcosystemError(refusal.code, refusal.message);
        return { reason: optionalText(body.reason, 1000), payload: { name: `handle:${handle}`, target: { handle }, submitter } };
      }
      const listing = await listings.byId(requiredText(target.listingId, 'target.listingId', 64));
      const owner = listing ? await publishers.byId(listing.publisherId) : null;
      if (!listing || owner?.ownerOrgId !== null) throw new EcosystemError(ErrorCode.NOT_FOUND, 'Only listings of the platform community publisher can be claimed.');
      // the claimer's VERIFIED email, hashed, so approval can link the
      // listing's anonymous submissions to this account (never returned by the API).
      const claimantEmailHash = claimantEmailHashOf(caller);
      return {
        reason: optionalText(body.reason, 1000),
        payload: { name: `listing:${listing.id}`, target: { listingId: listing.id }, submitter, ...(claimantEmailHash ? { claimantEmailHash } : {}) },
      };
    }
    case 'profile_change': {
      const target = (body.target ?? {}) as Record<string, unknown>;
      const out: { handle?: string; displayName?: string } = {};
      if (typeof target.handle === 'string' && target.handle.trim().toLowerCase() !== publisher.handle) {
        const handle = target.handle.trim().toLowerCase();
        const refusal = await handleRefusal(handle, publisher.id);
        if (refusal) throw new EcosystemError(refusal.code, refusal.message);
        out.handle = handle;
      }
      if (target.displayName !== undefined) {
        const name = displayNameOf(target.displayName);
        if (name !== publisher.displayName) out.displayName = name;
      }
      if (!out.handle && !out.displayName) throw new EcosystemError(ErrorCode.VALIDATION_ERROR, 'Nothing changes.');
      return { reason: optionalText(body.reason, 1000), payload: { name: 'profile', target: out, submitter } };
    }
    case 'verify': {
      if (publisher.tier !== 'community') throw new EcosystemError(ErrorCode.CONFLICT, `The publisher is already ${publisher.tier}.`);
      const app = (body.application ?? {}) as Record<string, unknown>;
      const domain = optionalText(app.domain, 253);
      // Automatic eligibility: plan, a DNS-verified domain, owner MFA.
      const eligibility = await checkVerifiedEligibility(publisher.ownerOrgId ?? caller.orgId, { planEligible: verifiedEligible(caller), domain });
      assertVerifiedEligible(eligibility, 'application');
      return {
        payload: {
          name: 'verify',
          submitter,
          application: { domain, notes: optionalText(app.notes, 2000) },
          eligibility,
        },
      };
    }
    case 'advisory': {
      // A PRIVATE draft (security lane); only the system org publishes it.
      const built = await buildPublisherDraft(caller, publisher, body);
      return built.request;
    }
    default:
      throw new EcosystemError(ErrorCode.VALIDATION_ERROR, `Unknown request kind: ${String(kind)}`);
  }
}

/** The tenant permission that submits (and withdraws) a request of `kind`. */
function submitPermission(kind: string): Permission {
  return PUBLISH_PERMISSION_REQUEST_KINDS.includes(kind) ? 'plugins:publish' : 'publishers:manage';
}

/**
 * POST /plugins/publish-requests — submit a request as the caller's publisher.
 * Returns the stored request, decided at once when the bootstrap exception or
 * an auto-approval rule covers it.
 */
export async function submit(caller: Caller, body: Record<string, unknown>): Promise<{ request: ReturnType<typeof requestView>; autoApproved: boolean }> {
  const kind = body.kind as PublishRequestKind;
  if (!(TENANT_REQUEST_KINDS as readonly string[]).includes(kind)) {
    throw new EcosystemError(ErrorCode.VALIDATION_ERROR, `kind must be one of: ${TENANT_REQUEST_KINDS.join(', ')}`);
  }
  const permission = submitPermission(kind);
  if (!can(caller, permission)) throw new EcosystemError(ErrorCode.INSUFFICIENT_PERMISSIONS, `${kind} requests need ${permission}.`);
  assertRootOrg(caller);
  assertPublishingOpen(caller);
  const publisher = await ownPublisher(caller);
  assertPublisherActive(publisher);

  const built = await buildRequest(caller, publisher, kind, body);
  const listingName = (built.payload as Record<string, unknown>).name as string;
  // A listing can carry several advisory drafts at once (the open-request unique index exempts them too).
  const duplicate = kind === 'advisory' ? undefined : (await requests.list({ publisherId: publisher.id, statuses: OPEN_STATUSES, kinds: [kind] }))
    .find((r) => (r.listingId ?? r.payload?.name) === (built.listingId ?? listingName) && (r.version ?? null) === (built.version ?? null));
  if (duplicate) {
    throw new EcosystemError(ErrorCode.DUPLICATE_ENTRY, 'An open request of this kind already exists for it.', { requestId: duplicate.id });
  }

  let stored: Req;
  try {
    stored = await requests.insert({ ...built, kind, publisherId: publisher.id, submittedBy: caller.userId, submittedOrgId: caller.orgId });
  } catch (err) {
    await releaseFreeze(built.pluginId ?? null);
    const advisoryId = (built.payload as { advisoryId?: string }).advisoryId;
    if (kind === 'advisory' && advisoryId) await removeDraft(advisoryId);
    if (isUniqueViolation(err)) throw new EcosystemError(ErrorCode.DUPLICATE_ENTRY, 'An open request of this kind already exists for it.');
    throw err;
  }

  const listing = stored.listingId ? await listings.byId(stored.listingId) : null;
  const title = requestTitle({ kind, handle: publisher.handle, name: listing?.name ?? listingName.replace(/^(handle|listing):/, ''), version: stored.version });
  ecosystemAudit({
    action: 'plugin.request.submit',
    actor: actorId({ userId: caller.userId }),
    orgId: caller.orgId,
    affectedOrgId: caller.orgId,
    targetType: 'plugin-publish-request',
    targetId: stored.id,
    details: { kind, ...(stored.digest ? { digest: stored.digest } : {}), ...(stored.version ? { version: stored.version } : {}), securityFix: stored.lane === 'security' },
  });
  if (kind === 'advisory') {
    const p = stored.payload as { advisoryId: string; severity: string; affectedRange: string };
    ecosystemAudit({
      action: 'plugin.advisory.create',
      actor: actorId({ userId: caller.userId }),
      orgId: caller.orgId,
      affectedOrgId: caller.orgId,
      targetType: 'plugin-advisory',
      targetId: p.advisoryId,
      details: { source: 'publisher', listing: `${publisher.handle}/${listingName}`, severity: p.severity, affectedRange: p.affectedRange, requestId: stored.id },
    });
  }
  if (kind === 'verify') {
    ecosystemAudit({ action: 'publisher.verify.request', actor: actorId({ userId: caller.userId }), orgId: caller.orgId, targetType: 'publisher', targetId: publisher.id, details: { requestId: stored.id } });
  }
  if (kind === 'transfer') {
    const t = (stored.payload as { transfer: { targetOrgId: string } }).transfer;
    ecosystemAudit({ action: 'publisher.transfer.request', actor: actorId({ userId: caller.userId }), orgId: caller.orgId, affectedOrgId: t.targetOrgId, targetType: 'plugin-listing', targetId: stored.listingId!, details: { requestId: stored.id } });
    await notifyTransferRequested({ receivingOrgId: t.targetOrgId, title });
  } else {
    await notifyRequestSubmitted({ kind, lane: stored.lane, title, submittedOrgId: caller.orgId, permission: requiredDecisionPermission(kind) });
  }

  const decided = await autoDecide(stored, publisher, caller);
  return { request: requestView(decided ?? stored, publisher, listing?.name ?? null), autoApproved: decided !== null };
}

/** POST /plugins/publish-requests/:id/withdraw — the submitting publisher takes back an open request. */
export async function withdraw(caller: Caller, id: string) {
  const publisher = await ownPublisher(caller);
  const r = await requests.byId(id);
  if (!r || r.publisherId !== publisher.id) throw new EcosystemError(ErrorCode.NOT_FOUND, 'Request not found');
  const permission = submitPermission(r.kind);
  if (!can(caller, permission)) throw new EcosystemError(ErrorCode.INSUFFICIENT_PERMISSIONS, `Withdrawing ${r.kind} requests needs ${permission}.`);
  if (!OPEN_STATUSES.includes(r.status)) throw new EcosystemError(ErrorCode.CONFLICT, `This request is ${r.status}.`);
  const done = await requests.transition(r.id, r.status, { status: 'withdrawn', decidedBy: caller.userId, decidedAt: new Date() });
  if (!done) throw new EcosystemError(ErrorCode.CONFLICT, 'The request was decided meanwhile.');
  await releaseFreeze(r.pluginId);
  await discardDraft(r);
  ecosystemAudit({
    action: 'plugin.request.withdraw',
    actor: actorId({ userId: caller.userId }),
    orgId: caller.orgId,
    targetType: 'plugin-publish-request',
    targetId: r.id,
    details: { kind: r.kind },
  });
  return requestView(done, publisher, null);
}

/** Views for a list of requests (listings and publishers each read in ONE batched query). */
export async function requestViews(rows: Req[]) {
  const listingIds = [...new Set(rows.map((r) => r.listingId).filter((x): x is string => !!x))];
  const [listingRows, publisherRows] = await Promise.all([
    listings.byIds(listingIds),
    publishers.byIds([...new Set(rows.map((r) => r.publisherId))]),
  ]);
  const names = new Map(listingRows.map((l) => [l.id, l.name]));
  const pubs = new Map(publisherRows.map((p) => [p.id, p]));
  return rows.map((r) => requestView(r, pubs.get(r.publisherId) ?? null, r.listingId ? names.get(r.listingId) ?? null : null));
}

/** Page size bounds for the publisher-side request lists. */
const PAGE_DEFAULT = 50;
const PAGE_MAX = 200;

/** `limit` + `cursor` from a query string (400 on a malformed cursor). */
export function pageParams(query: { limit?: unknown; cursor?: unknown }): { limit: number; cursor: RequestCursor | null } {
  const { limit } = parsePage(query, { def: PAGE_DEFAULT, max: PAGE_MAX });
  const cursor = decodeRequestCursor(query.cursor);
  if (cursor === 'invalid') throw new EcosystemError(ErrorCode.VALIDATION_ERROR, 'cursor is not a valid page cursor', { field: 'cursor' });
  return { limit, cursor };
}

/** One page of `filter` (limit + 1 read to tell whether another page exists). */
async function pageOf(filter: RequestFilter, page: { limit: number; cursor: RequestCursor | null }) {
  const rows = await requests.list({ ...filter, limit: page.limit + 1, cursor: page.cursor });
  const items = rows.slice(0, page.limit);
  const nextCursor = rows.length > page.limit ? encodeRequestCursor(items[items.length - 1]!) : null;
  return { items, nextCursor };
}


/** A page of request views plus the cursor for the next one (null = last page). */
export interface RequestPage { requests: ReturnType<typeof requestView>[]; nextCursor: string | null }

/** GET /plugins/publish-requests — the caller's publisher's requests, newest first, paged. */
export async function ownRequests(caller: Caller, query: { status?: unknown; limit?: unknown; cursor?: unknown } = {}): Promise<RequestPage> {
  const page = pageParams(query);
  const publisher = await publishers.byOrg(caller.orgId);
  if (!publisher) return { requests: [], nextCursor: null };
  const statuses = typeof query.status === 'string' ? REQUEST_STATUS_FILTERS[query.status] : undefined;
  const { items, nextCursor } = await pageOf({ publisherId: publisher.id, ...(statuses ? { statuses } : {}) }, page);
  return { requests: await requestViews(items), nextCursor };
}

/** GET /plugins/publisher/incoming-transfers — open transfers offered TO the caller's publisher (filtered in SQL), paged. */
export async function incomingTransfers(caller: Caller, query: { limit?: unknown; cursor?: unknown } = {}): Promise<RequestPage> {
  const page = pageParams(query);
  const publisher = await publishers.byOrg(caller.orgId);
  if (!publisher) return { requests: [], nextCursor: null };
  const { items, nextCursor } = await pageOf({ statuses: OPEN_STATUSES, kinds: ['transfer'], transferTargetPublisherId: publisher.id }, page);
  return { requests: await requestViews(items), nextCursor };
}

/**
 * POST /plugins/publish-requests/:id/transfer-response — the RECEIVING
 * publisher accepts (the system org then decides) or declines (the transfer
 * ends). N10 to both orgs.
 */
export async function respondToTransfer(caller: Caller, id: string, accept: boolean) {
  assertRootOrg(caller);
  const publisher = await ownPublisher(caller);
  const r = await requests.byId(id);
  const transfer = (r?.payload as { transfer?: { targetPublisherId?: string; response?: string } } | undefined)?.transfer;
  if (!r || r.kind !== 'transfer' || transfer?.targetPublisherId !== publisher.id) throw new EcosystemError(ErrorCode.NOT_FOUND, 'Transfer not found');
  if (r.status !== 'pending' || transfer.response !== 'pending') throw new EcosystemError(ErrorCode.CONFLICT, 'This transfer was already answered.');
  const payload = { ...r.payload, transfer: { ...transfer, response: accept ? 'accepted' : 'declined', respondedBy: caller.userId, respondedAt: new Date().toISOString() } };
  const updated = await requests.transition(r.id, 'pending', accept
    ? { payload }
    : { payload, status: 'rejected', reason: 'Declined by the receiving publisher', decidedBy: caller.userId, decidedAt: new Date() });
  if (!updated) throw new EcosystemError(ErrorCode.CONFLICT, 'The transfer was decided meanwhile.');
  const sender = await publishers.byId(r.publisherId);
  const listing = r.listingId ? await listings.byId(r.listingId) : null;
  ecosystemAudit({
    action: accept ? 'publisher.transfer.accept' : 'publisher.transfer.decline',
    actor: actorId({ userId: caller.userId }),
    orgId: caller.orgId,
    affectedOrgId: sender?.ownerOrgId,
    targetType: 'plugin-publish-request',
    targetId: r.id,
    details: { listing: listing?.name ?? null },
  });
  const title = `${sender?.handle ?? ''}/${listing?.name ?? ''}`;
  await notifyTransferUpdate({ orgIds: [sender?.ownerOrgId ?? null, caller.orgId], title, outcome: accept ? 'accepted (awaiting system-org approval)' : 'declined' });
  if (accept) await notifyRequestSubmitted({ kind: 'transfer', lane: r.lane, title, submittedOrgId: r.submittedOrgId, permission: 'publishers:verify' });
  return requestView(updated, sender, listing?.name ?? null);
}

/**
 * Submit the version request the upload's `publishRequest=true` asked for, once
 * the build has deployed the version (the Official catalog loader's path, and
 * any scripted publisher). A new name gets a new_listing, a listed name a
 * new_version. For the Official loader a new version whose detected metadata
 * differs from the listing also gets a `listing_update` (auto-approved only for
 * text-only changes). Never throws: the build succeeded either way;
 * the refusal is returned for the build log.
 */
export async function submitAfterBuild(submitter: Caller, pluginId: string): Promise<{ ok: boolean; message: string; requestId?: string; status?: string }> {
  try {
    const publisher = await publishers.byOrg(submitter.orgId);
    const plugin = await plugins.byId(pluginId, submitter.orgId);
    if (!publisher || !plugin) return { ok: false, message: publisher ? 'The deployed version was not found' : 'The organization has no publisher' };
    const listing = await listings.byName(publisher.id, plugin.name);
    if (listing && await versions.get(listing.id, plugin.version)) return { ok: true, message: `${plugin.name} ${plugin.version} is already listed` };
    const { request } = await submit(submitter, { kind: listing ? 'new_version' : 'new_listing', pluginId });
    if (listing && publisher.handle === OFFICIAL_PUBLISHER_HANDLE) {
      const offer = listingUpdateOffer(plugin, listing);
      if (offer.length > 0) {
        await submit(submitter, {
          kind: 'listing_update',
          listingId: listing.id,
          metadata: Object.fromEntries(offer.map((o) => [o.field, o.value])),
          sources: Object.fromEntries(offer.map((o) => [o.field, o.source ?? 'spec'])),
        }).catch((err: Error) => ({ request: null, error: err.message }));
      }
    }
    return { ok: true, message: `Publish request ${request.status === 'approved' ? 'approved' : 'submitted'}`, requestId: request.id, status: request.status };
  } catch (err) {
    return { ok: false, message: (err as Error).message };
  }
}
