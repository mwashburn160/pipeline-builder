// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * LISTED-VERSION DEPRECATION (docs/plugin-publishing.md, N14,
 * `plugin.version.deprecate`).
 *
 * Deprecation only NARROWS, like pausing a listing: the version keeps
 * resolving, lookup prints a warning, AI selection skips it, and every
 * installing org gets N14. Because nothing breaks, a publisher may deprecate
 * its OWN listed version at once, with no review — there is no tenant
 * un-deprecate, only the system org can clear one.
 *
 * Three ways in, one write ({@link markDeprecated}), so the audit row, the
 * idempotency rule (re-deprecating with the same message is a no-op) and the
 * single N14 per version hold whichever door was used:
 *
 *  - the publisher, on its own listing ({@link deprecateOwnListedVersion});
 *  - the system org, which may also CLEAR ({@link setListedVersionDeprecation});
 *  - the source org plugin row being deprecated, which carries over to every
 *    listing version published from it ({@link deprecateListedFromSource}).
 *
 * Distinct from a security ADVISORY (advisories.ts): an advisory says a version
 * is DANGEROUS and can make lookup refuse it; deprecation says it is
 * unsupported and never refuses.
 */

import {
  actorId,
  createLogger,
  ErrorCode,
  errorMessage,
  SYSTEM_ORG_ID,
} from '@pipeline-builder/api-core';
import type { PluginListing, PluginListingVersion, Publisher } from '@pipeline-builder/pipeline-data';

import { ecosystemAudit } from './audit.js';
import { can, EcosystemError, invalid, type Caller } from './context.js';
import { notifyInstallers } from './install-notify.js';
import { assertRootOrg, listingWithPublisher, ownPublisher } from './publishers.js';
import { listings, listingsWithPublishers, versions } from './store.js';
import { listingView } from './views.js';

const logger = createLogger('ecosystem-version-deprecation');

/** Deprecation message cap. */
export const DEPRECATION_MESSAGE_MAX = 500;

function deprecationMessageOf(raw: unknown, required: boolean): string | null {
  if (raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '')) {
    if (required) throw new EcosystemError(ErrorCode.MISSING_REQUIRED_FIELD, 'message is required (why the version is deprecated and what to use instead)');
    return null;
  }
  if (typeof raw !== 'string') invalid('message must be a string');
  const message = raw.trim().replace(/\s+/g, ' ');
  if (message.length > DEPRECATION_MESSAGE_MAX) invalid(`message must be at most ${DEPRECATION_MESSAGE_MAX} characters`);
  return message;
}

/** N14 to the orgs whose install reaches the version. */
function notifyVersionDeprecated(publisher: Publisher, listing: PluginListing, version: string, message: string | null): Promise<number> {
  const ref = `${publisher.handle}/${listing.name}@${version}`;
  return notifyInstallers('N14', publisher, listing, {
    subject: `Plugin ${ref} is deprecated`,
    text: `${ref}, installed in your organization, was deprecated by its publisher${message ? `: ${message}` : '.'} `
      + 'It keeps resolving, but synth prints a warning. Move your pipelines to a supported version.',
  }, { version });
}

/** Mark one listed version deprecated (idempotent; a new message replaces the old one). Returns whether it was newly deprecated. */
async function markDeprecated(
  v: PluginListingVersion, listing: PluginListing, publisher: Publisher, message: string | null,
  audit: { actor: string; orgId: string; via: 'publisher' | 'system_org' | 'source_plugin' },
): Promise<boolean> {
  const fresh = v.deprecatedAt === null;
  if (!fresh && (v.deprecationMessage ?? null) === message) return false;
  await versions.update(v.id, { deprecatedAt: v.deprecatedAt ?? new Date(), deprecationMessage: message });
  ecosystemAudit({
    action: 'plugin.version.deprecate',
    actor: audit.actor,
    orgId: audit.orgId,
    affectedOrgId: publisher.ownerOrgId,
    targetType: 'plugin-listing-version',
    targetId: v.id,
    details: { listing: `${publisher.handle}/${listing.name}`, version: v.version, deprecated: true, via: audit.via },
  });
  if (fresh) await notifyVersionDeprecated(publisher, listing, v.version, message);
  return fresh;
}

/**
 * POST /plugins/publisher/listings/:listingId/deprecate — the publisher
 * deprecates one of its OWN listed versions, at once and without review: it
 * only narrows (lookup warns, AI selection skips it, N14 to installers). There
 * is no tenant un-deprecate.
 */
export async function deprecateOwnListedVersion(caller: Caller, listingId: string, body: Record<string, unknown>) {
  assertRootOrg(caller);
  if (!can(caller, 'plugins:publish')) throw new EcosystemError(ErrorCode.INSUFFICIENT_PERMISSIONS, 'Deprecating needs plugins:publish');
  const publisher = await ownPublisher(caller);
  const listing = await listings.byId(listingId);
  if (!listing || listing.publisherId !== publisher.id) throw new EcosystemError(ErrorCode.NOT_FOUND, 'Listing not found');
  if (typeof body.version !== 'string' || body.version === '') throw new EcosystemError(ErrorCode.MISSING_REQUIRED_FIELD, 'version is required');
  const v = await versions.get(listing.id, body.version);
  if (!v) throw new EcosystemError(ErrorCode.NOT_FOUND, 'Version not found');
  const message = deprecationMessageOf(body.message, true);
  await markDeprecated(v, listing, publisher, message, { actor: actorId({ userId: caller.userId }), orgId: caller.orgId, via: 'publisher' });
  return listingView((await listings.byId(listing.id))!, publisher, { versions: await versions.forListings([listing.id]) });
}

/** POST /plugins/ecosystem/listings/:id/versions/:version/deprecate — the system org deprecates (or, `deprecated: false`, clears) a listed version. */
export async function setListedVersionDeprecation(caller: Caller, listingId: string, version: string, body: Record<string, unknown>) {
  if (!can(caller, 'plugins:moderate')) throw new EcosystemError(ErrorCode.INSUFFICIENT_PERMISSIONS, 'Deprecating needs plugins:moderate');
  const { listing, publisher } = await listingWithPublisher(listingId);
  const v = await versions.get(listing.id, version);
  if (!v) throw new EcosystemError(ErrorCode.NOT_FOUND, 'Version not found');
  const actor = actorId({ userId: caller.userId });
  if (body.deprecated === false) {
    if (v.deprecatedAt !== null) {
      await versions.update(v.id, { deprecatedAt: null, deprecationMessage: null });
      ecosystemAudit({
        action: 'plugin.version.deprecate',
        actor: actor,
        affectedOrgId: publisher.ownerOrgId,
        targetType: 'plugin-listing-version',
        targetId: v.id,
        details: { listing: `${publisher.handle}/${listing.name}`, version, deprecated: false, via: 'system_org' },
      });
    }
  } else {
    await markDeprecated(v, listing, publisher, deprecationMessageOf(body.message, false), { actor, orgId: SYSTEM_ORG_ID, via: 'system_org' });
  }
  return listingView((await listings.byId(listing.id))!, publisher, { versions: await versions.forListings([listing.id]) });
}

/**
 * Deprecating an org plugin row carries over to every listing version
 * published FROM it ( `POST /plugins/:id/deprecate` and a `lifecycle:
 * deprecated` update, through deprecation-notice.ts). Never throws; returns how
 * many listed versions were newly deprecated.
 */
export async function deprecateListedFromSource(
  plugin: { id: string; orgId: string; deprecationMessage?: string | null },
  actor: string,
): Promise<number> {
  try {
    const listed = await versions.bySourcePlugins([plugin.id]);
    const owners = await listingsWithPublishers(listed.map((v) => v.listingId));
    let count = 0;
    for (const v of listed) {
      const { listing, publisher } = owners.get(v.listingId) ?? { listing: null, publisher: null };
      if (!listing || !publisher || v.deprecatedAt !== null) continue;
      if (await markDeprecated(v, listing, publisher, plugin.deprecationMessage?.trim() || null, { actor, orgId: plugin.orgId, via: 'source_plugin' })) count++;
    }
    return count;
  } catch (err) {
    logger.warn('Listed-version deprecation from the source plugin failed', { pluginId: plugin.id, error: errorMessage(err) });
    return 0;
  }
}
