// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The review view's data (docs/plans/plugin-ecosystem.md §3.0.2): every
 * request is shown against the previous APPROVED version — per-field metadata
 * with provenance (user-edited links highlighted, G36), the execution-contract
 * delta (secrets, egress, required inputs, env keys, commands, root), the
 * vulnerability delta, the Dockerfile, the SBOM package delta, the icon, the
 * gates, the publisher's history and the auto-approval verdict. Auto-approval
 * uses exactly these diffs.
 */

import { createLogger, errorMessage, PLUGIN_CATALOG_FIELDS, SYSTEM_ORG_ID, type PluginCatalogField } from '@pipeline-builder/api-core';
import { Config } from '@pipeline-builder/pipeline-core';
import type { PluginListing, PluginPublishRequest, Publisher } from '@pipeline-builder/pipeline-data';

import { autoApprovalFacts, bootstrapState, matchingRule, previousVersion } from './decisions.js';
import { effectiveMetadata, listingFieldValue, type RequestMetadata } from './metadata.js';
import { contractDiff, isLinkField, sameValue, specSnapshot, versionGates, vulnDelta } from './policy.js';
import { listings, plugins, requests, type PluginRow } from './store.js';
import { gateReportOf, submissionForRequest, submissionReview } from './submission-moderation.js';
import { fetchImageSbom, fetchPublicImageSbom } from '../../helpers/supply-chain.js';

const logger = createLogger('ecosystem-review');

/** `name@version` for every package in an SPDX document. */
export function sbomPackages(sbom: Record<string, unknown>): string[] {
  const pkgs = Array.isArray(sbom.packages) ? sbom.packages as Array<Record<string, unknown>> : [];
  return [...new Set(pkgs
    .map((p) => (typeof p.name === 'string' ? `${p.name}${typeof p.versionInfo === 'string' ? `@${p.versionInfo}` : ''}` : null))
    .filter((x): x is string => x !== null))].sort();
}

/** SBOM package delta between the previous published image and the requested one (best-effort). */
async function sbomDiff(plugin: PluginRow, previous: { imageRepository: string | null; imageDigest: string | null } | null) {
  if (!plugin.imageDigest) return null;
  try {
    const registry = Config.get('registry');
    const current = sbomPackages(await fetchImageSbom({ orgId: plugin.orgId, name: plugin.name, imageDigest: plugin.imageDigest }, registry));
    const prior = previous?.imageRepository && previous.imageDigest
      ? sbomPackages(await fetchPublicImageSbom(previous.imageRepository, previous.imageDigest, registry)) : [];
    const prev = new Set(prior);
    const cur = new Set(current);
    return { added: current.filter((p) => !prev.has(p)), removed: prior.filter((p) => !cur.has(p)), error: null };
  } catch (err) {
    logger.debug('SBOM diff unavailable', { plugin: plugin.id, error: errorMessage(err) });
    return { added: [], removed: [], error: `The SBOM could not be read: ${errorMessage(err)}` };
  }
}

/** Per-field metadata rows: the proposed value next to the live / previous one, with provenance. */
function metadataRows(r: PluginPublishRequest, plugin: PluginRow | null, listing: PluginListing | null) {
  const payload = (r.payload ?? {}) as { metadata?: RequestMetadata };
  const proposed = payload.metadata ?? (plugin ? effectiveMetadata(plugin) : { values: {}, sources: {} });
  const fields = r.kind === 'listing_update' ? Object.keys(proposed.values) as PluginCatalogField[] : [...PLUGIN_CATALOG_FIELDS];
  return fields.map((field) => {
    const value = proposed.values[field] ?? null;
    const previous = listing ? listingFieldValue(listing, field) : null;
    const source = proposed.sources[field] ?? null;
    const userEdited = source === 'user';
    const changed = listing ? !sameValue(value, previous) : value !== null;
    return { field, value, previous, source, changed, userEdited, isLink: isLinkField(field), highlight: userEdited && isLinkField(field) && changed };
  });
}

/** GET /ecosystem/requests/:id → `review`. */
export async function reviewDiff(r: PluginPublishRequest, publisher: Publisher) {
  if (r.kind === 'submission') return submissionReviewDiff(r, publisher);
  const listing = r.listingId ? await listings.byId(r.listingId) : null;
  const plugin = r.pluginId ? await plugins.byId(r.pluginId) : null;
  const isVersion = (r.kind === 'new_listing' || r.kind === 'new_version') && plugin !== null;
  const prev = isVersion ? await previousVersion(listing?.id ?? null, r.version) : null;
  const current = plugin ? specSnapshot(plugin) : null;

  const history = await requests.list({ publisherId: publisher.id, limit: 500 });
  const ownListings = await listings.list({ publisherId: publisher.id });
  const verdict = await matchingRule(r, publisher, listing, plugin);
  const bootstrap = await bootstrapState();
  const facts = isVersion ? await autoApprovalFacts(r, publisher, listing, plugin) : null;

  return {
    previousVersion: prev?.version ?? null,
    metadata: metadataRows(r, plugin, listing),
    contract: isVersion && current ? contractDiff(prev?.specSnapshot ?? null, current) : null,
    vuln: isVersion && plugin ? {
      previous: prev ? { critical: prev.vulnCritical, high: prev.vulnHigh } : null,
      current: { critical: plugin.vulnCritical, high: plugin.vulnHigh, scannedAt: plugin.scannedAt ? new Date(plugin.scannedAt).toISOString() : null },
      ...vulnDelta(prev ? { critical: prev.vulnCritical, high: prev.vulnHigh } : null, { critical: plugin.vulnCritical, high: plugin.vulnHigh }),
    } : null,
    dockerfile: isVersion && plugin ? {
      previous: (prev?.specSnapshot?.dockerfile as string | null | undefined) ?? null,
      current: plugin.dockerfile ?? null,
      changed: ((prev?.specSnapshot?.dockerfile as string | null | undefined) ?? null) !== (plugin.dockerfile ?? null),
    } : null,
    sbom: isVersion && plugin ? await sbomDiff(plugin, prev) : null,
    icon: isVersion || r.kind === 'listing_update' ? (() => {
      const proposed = ((r.payload as { metadata?: RequestMetadata }).metadata?.values.icon ?? plugin?.icon ?? null);
      const previous = listing?.icon ?? null;
      // A curated vendor mark (a `key` icon) is reserved for Official listings
      // and Verified owners of the mark (§6a.1, G51): flag it for anyone else.
      const curatedMark = !!proposed && typeof proposed === 'object' && 'key' in (proposed as object) && !['official', 'verified'].includes(publisher.tier);
      return { previous, current: proposed, changed: !sameValue(proposed, previous), curatedMark };
    })() : null,
    gates: isVersion && plugin ? versionGates(plugin) : [],
    publisherHistory: {
      tier: publisher.tier,
      createdAt: new Date(publisher.createdAt).toISOString(),
      listings: ownListings.length,
      approved: history.filter((h) => h.status === 'approved').length,
      rejected: history.filter((h) => h.status === 'rejected').length,
    },
    autoApproval: {
      eligible: verdict.rule !== null,
      ruleId: verdict.rule?.id ?? null,
      ruleName: verdict.rule?.name ?? null,
      reasons: verdict.reasons,
      ...(facts?.bump ? { bump: facts.bump } : {}),
      bootstrapOpen: !bootstrap.closedAt && bootstrap.openedAt !== null,
    },
  };
}

/** The publisher's request history + the auto-approval verdict (shared by every review). */
async function historyAndVerdict(r: PluginPublishRequest, publisher: Publisher, listing: PluginListing | null) {
  const history = await requests.list({ publisherId: publisher.id, limit: 500 });
  const ownListings = await listings.list({ publisherId: publisher.id });
  const verdict = await matchingRule(r, publisher, listing, null);
  const bootstrap = await bootstrapState();
  return {
    publisherHistory: {
      tier: publisher.tier,
      createdAt: new Date(publisher.createdAt).toISOString(),
      listings: ownListings.length,
      approved: history.filter((h) => h.status === 'approved').length,
      rejected: history.filter((h) => h.status === 'rejected').length,
    },
    autoApproval: {
      eligible: verdict.rule !== null,
      ruleId: verdict.rule?.id ?? null,
      ruleName: verdict.rule?.name ?? null,
      reasons: verdict.reasons,
      bootstrapOpen: !bootstrap.closedAt && bootstrap.openedAt !== null,
    },
  };
}

/**
 * The same review shape for an anonymous `submission` request (§3.0.2, §4.2):
 * the quarantined build against the previous APPROVED version of the same
 * community listing — metadata with provenance, contract, vulnerabilities,
 * Dockerfile, SBOM packages, icon and the recorded gate results.
 */
async function submissionReviewDiff(r: PluginPublishRequest, publisher: Publisher) {
  const listing = r.listingId ? await listings.byId(r.listingId) : null;
  const sub = await submissionReview(r);
  const s = await submissionForRequest(r);
  const facts = gateReportOf(s)?.facts ?? null;
  const prev = listing ? await previousVersion(listing.id, s.version) : null;

  let sbom: { added: string[]; removed: string[]; error: string | null } | null = null;
  if (facts) {
    try {
      const registry = Config.get('registry');
      const current = sbomPackages(await fetchImageSbom({ orgId: SYSTEM_ORG_ID, name: s.name, imageDigest: facts.digest, imageRepository: facts.imageRepository }, registry));
      const prior = prev?.imageRepository && prev.imageDigest ? sbomPackages(await fetchPublicImageSbom(prev.imageRepository, prev.imageDigest, registry)) : [];
      sbom = { added: current.filter((x) => !prior.includes(x)), removed: prior.filter((x) => !current.includes(x)), error: null };
    } catch (err) {
      sbom = { added: [], removed: [], error: `The SBOM could not be read: ${errorMessage(err)}` };
    }
  }
  const proposedIcon = (s.catalog?.values as Record<string, unknown> | undefined)?.icon ?? null;
  const previousIcon = listing?.icon ?? null;
  const previousCounts = prev ? { critical: prev.vulnCritical, high: prev.vulnHigh } : null;
  return {
    previousVersion: sub.previousVersion,
    metadata: sub.metadata,
    contract: sub.contract,
    vuln: facts ? {
      previous: previousCounts,
      current: { critical: facts.vulnCritical, high: facts.vulnHigh, scannedAt: facts.scannedAt },
      ...vulnDelta(previousCounts, { critical: facts.vulnCritical, high: facts.vulnHigh }),
    } : null,
    dockerfile: sub.dockerfile,
    sbom,
    icon: {
      previous: previousIcon,
      current: proposedIcon,
      changed: !sameValue(proposedIcon, previousIcon),
      curatedMark: !!proposedIcon && typeof proposedIcon === 'object' && 'key' in (proposedIcon as object),
    },
    gates: sub.gateReport?.gates ?? [],
    ...await historyAndVerdict(r, publisher, listing),
  };
}
