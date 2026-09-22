// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Notices to INSTALLING ORGS (docs/plugin-publishing.md): N8
 * (moderation action), N13 (a new version outside the install's range), N14
 * (deprecated / unmaintained), N26 (paused by the publisher) and N27 (an
 * installed listing auto-updated within its range).
 *
 * "Installing orgs" = every org with an ACTIVE explicit install of the listing,
 * plus — for an Official listing — every org that uses it through the implicit
 * install (its pipelines reference it, and its policy doesn't opt out or
 * block it). Recipients are per-org RULES (`plugin_installs:manage`, falling
 * back to the root org's holders and then the owners), resolved and mailed
 * individually by platform, so a publisher never learns who installed and no
 * org sees another's name ( "Privacy").
 */

import {
  createLogger,
  errorMessage,
  type EcosystemNotificationEventId,
  type EcosystemRecipientSpec,
} from '@pipeline-builder/api-core';
import { incCounter } from '@pipeline-builder/api-server';
import {
  compareSemver,
  implicitInstallRange,
  installAdmits,
  listingBlock,
  OFFICIAL_PUBLISHER_HANDLE,
  parseSemver,
  policyOf,
  satisfiesVersionSpec,
  type PluginInstall,
  type PluginListing,
  type PluginListingVersion,
  type Publisher,
} from '@pipeline-builder/pipeline-data';

import { implicitOfficialUsers, installRows, listingSource } from './installs-store.js';
import { vulnDelta } from './policy.js';
import { enqueueEcosystemNotification, type EnqueueOptions } from '../ecosystem-notifications.js';

const logger = createLogger('ecosystem-install-notify');

/** Recipient rules per relay request (the relay caps a request at 50). */
export const INSTALLER_RECIPIENT_CHUNK = 50;

/** The org-approvers rule for one installing org. */
export const orgApprovers = (orgId: string): EcosystemRecipientSpec =>
  ({ kind: 'org_permission', orgId, permission: 'plugin_installs:manage', inheritFromRoot: true });

/** One installing org and the install it reaches the listing through. */
export interface InstallingOrg {
  orgId: string;
  /** The explicit install row, or null for the implicit Official install. */
  install: PluginInstall | null;
}

/**
 * Every org installing `listing` (see the module doc). With `version`, only
 * the orgs whose install reaches that version: an explicit install whose range
 * admits it (or that resolved to it), an implicit user whose pipelines can
 * resolve it.
 */
export async function installingOrgs(publisher: Pick<Publisher, 'handle' | 'tier' | 'suspendedAt'>, listing: Pick<PluginListing, 'id' | 'name' | 'state'>, version?: string): Promise<InstallingOrg[]> {
  const rows = await installRows.forListing(listing.id);
  const all = version ? await listingSource.versionsForListings([listing.id]) : [];
  const out = new Map<string, InstallingOrg>();
  for (const row of rows) {
    if (row.status !== 'active') continue;
    if (version && row.resolvedVersion !== version && !installAdmits(row, version, all)) continue;
    out.set(row.orgId.toLowerCase(), { orgId: row.orgId.toLowerCase(), install: row });
  }
  if (publisher.handle === OFFICIAL_PUBLISHER_HANDLE) {
    // Orgs holding ANY explicit row (pending or denied too) are judged by it above.
    const explicit = new Set(rows.map((r) => r.orgId.toLowerCase()));
    const candidates = (await implicitOfficialUsers(listing.name, version)).filter((o) => !explicit.has(o));
    const policies = new Map((await listingSource.policiesForOrgs(candidates)).map((p) => [p.orgId.toLowerCase(), policyOf(p)]));
    for (const orgId of candidates) {
      const policy = policies.get(orgId) ?? policyOf(null);
      if (policy.officialInstalls === 'explicit' || listingBlock(policy, publisher, listing)) continue;
      out.set(orgId, { orgId, install: null });
    }
  }
  return [...out.values()].sort((a, b) => a.orgId.localeCompare(b.orgId));
}

/** Send one notice to the approvers of each of `orgIds` (chunked). Never throws. */
export async function sendToOrgs(
  event: EcosystemNotificationEventId,
  orgIds: readonly string[],
  content: { subject: string; text: string },
  opts: EnqueueOptions = {},
): Promise<number> {
  const unique = [...new Set(orgIds)];
  if (unique.length === 0) return 0;
  try {
    for (let i = 0; i < unique.length; i += INSTALLER_RECIPIENT_CHUNK) {
      await enqueueEcosystemNotification(event, unique.slice(i, i + INSTALLER_RECIPIENT_CHUNK).map(orgApprovers),
        { subject: content.subject.slice(0, 500), text: content.text.slice(0, 10_000) }, opts);
    }
    return unique.length;
  } catch (err) {
    incCounter('ecosystem_notification_failed_total', { event });
    logger.warn('Installer notice not sent', { event, error: errorMessage(err) });
    return 0;
  }
}

/** Notify the installing orgs of a listing (optionally only those reaching `version`). Never throws. */
export async function notifyInstallers(
  event: EcosystemNotificationEventId,
  publisher: Pick<Publisher, 'handle' | 'tier' | 'suspendedAt'>,
  listing: Pick<PluginListing, 'id' | 'name' | 'state'>,
  content: { subject: string; text: string },
  opts: { version?: string } & EnqueueOptions = {},
): Promise<number> {
  const { version, ...enqueue } = opts;
  try {
    const orgs = await installingOrgs(publisher, listing, version);
    return await sendToOrgs(event, orgs.map((o) => o.orgId), content, enqueue);
  } catch (err) {
    incCounter('ecosystem_notification_failed_total', { event });
    logger.warn('Could not resolve installing orgs', { event, listingId: listing.id, error: errorMessage(err) });
    return 0;
  }
}

/** N26: the publisher paused the listing (or one version). In-app; installs keep resolving. */
export function notifyListingPaused(publisher: Publisher, listing: PluginListing, version?: string): Promise<number> {
  const ref = `${publisher.handle}/${listing.name}${version ? ` ${version}` : ''}`;
  return notifyInstallers('N26', publisher, listing, {
    subject: `Paused by its publisher: ${ref}`,
    text: version
      ? `${ref} was paused by its publisher. Pipelines already on it keep working, but new version ranges skip it.`
      : `${ref} was paused by its publisher. Your install keeps working; the listing takes no new installs.`,
  }, version ? { version } : {});
}

/** N14: an installed listing was marked unmaintained (or a listed version deprecated). */
export function notifyListingUnmaintained(publisher: Publisher, listing: PluginListing, reason?: string | null): Promise<number> {
  const ref = `${publisher.handle}/${listing.name}`;
  return notifyInstallers('N14', publisher, listing, {
    subject: `Plugin ${ref} is unmaintained`,
    text: `${ref}, installed in your organization, is now unmaintained: it gets no further updates${reason ? ` (${reason})` : ''}. `
      + 'It keeps resolving; plan a replacement.',
  });
}

/** Changelog + vulnerability delta lines for an upgrade notice. */
export function upgradeDetails(from: Pick<PluginListingVersion, 'vulnCritical' | 'vulnHigh'> | null, to: PluginListingVersion): string {
  const delta = vulnDelta(from ? { critical: from.vulnCritical, high: from.vulnHigh } : null, { critical: to.vulnCritical, high: to.vulnHigh });
  const vuln = delta.newCritical || delta.newHigh
    ? `Vulnerabilities: ${delta.newCritical} new critical, ${delta.newHigh} new high.`
    : 'Vulnerabilities: no new critical or high findings.';
  return [to.changelog?.trim() ? `Changelog:\n${to.changelog.trim().slice(0, 4000)}` : 'No changelog provided.', vuln].join('\n\n');
}

/**
 * A new version was published to `listing` (N13 / N27). For each installing
 * org: if its install's range takes the version, it will resolve it
 * automatically — N27 (weekly digest); otherwise it's an available upgrade —
 * N13 (weekly digest; immediate for a breaking or major version). Both carry
 * the changelog and the vulnerability delta against what the org runs now.
 */
export async function announceNewVersion(publisher: Publisher, listing: PluginListing, published: PluginListingVersion): Promise<{ n13: number; n27: number }> {
  try {
    const orgs = await installingOrgs(publisher, listing);
    if (orgs.length === 0) return { n13: 0, n27: 0 };
    const versions = await listingSource.versionsForListings([listing.id]);
    const others = versions.filter((v) => v.id !== published.id && !v.yankedAt);
    const range = implicitInstallRange(versions);
    // What an implicit user runs today: the highest version of the implicit range.
    const implicitCurrent = range
      ? others.filter((v) => !v.pausedAt && satisfiesVersionSpec(v.version, range))
        .reduce<string | null>((best, v) => (best === null || compareSemver(v.version, best) > 0 ? v.version : best), null)
      : null;
    const ref = `${publisher.handle}/${listing.name}`;
    const inRange: string[] = [];
    const outOfRange = new Map<string, string[]>();
    for (const org of orgs) {
      const current = org.install ? (org.install.resolvedVersion ?? org.install.pinnedVersion) : implicitCurrent;
      const admits = org.install
        ? installAdmits(org.install, published.version, versions)
        : range !== null && satisfiesVersionSpec(published.version, range);
      if (admits && !published.pausedAt) {
        inRange.push(org.orgId);
      } else if (!current || compareSemver(published.version, current) > 0) {
        const key = current ?? '';
        outOfRange.set(key, [...(outOfRange.get(key) ?? []), org.orgId]);
      }
    }
    const previous = others.reduce<PluginListingVersion | null>((best, v) => (best === null || compareSemver(v.version, best.version) > 0 ? v : best), null);
    const n27 = await sendToOrgs('N27', inRange, {
      subject: `${ref} updated to ${published.version}`,
      text: `${ref} ${published.version} is within your install's version policy, so new pipeline synths use it automatically.\n\n${upgradeDetails(previous, published)}`,
    });
    const major = (v: string | null) => (v ? parseSemver(v)?.major ?? null : null);
    let n13 = 0;
    for (const [current, orgIds] of outOfRange) {
      const from = current ? versions.find((v) => v.version === current) ?? null : previous;
      const breaking = published.breaking || (current !== '' && major(published.version) !== major(current));
      n13 += await sendToOrgs('N13', orgIds, {
        subject: `New version available: ${ref} ${published.version}${breaking ? ' (breaking)' : ''}`,
        text: `${ref} ${published.version} is available but outside your install's version policy${current ? ` (you run ${current})` : ''}. `
          + `Upgrade the install to use it.\n\n${upgradeDetails(from, published)}`,
      }, breaking ? { immediate: true } : {});
    }
    return { n13, n27: n27 };
  } catch (err) {
    logger.warn('New-version notices not sent', { listingId: listing.id, error: errorMessage(err) });
    return { n13: 0, n27: 0 };
  }
}
