// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The review view's data (docs/runbooks/ecosystem-moderation.md): every
 * request is shown against the previous APPROVED version — per-field metadata
 * with provenance (user-edited links highlighted), the execution-contract
 * delta (secrets, egress, required inputs, env keys, commands, root), the
 * vulnerability delta, the Dockerfile, the SBOM package delta, the icon, the
 * gates, the publisher's history and the auto-approval verdict. Auto-approval
 * uses exactly these diffs.
 */

import { createLogger, errorMessage, PLUGIN_CATALOG_FIELDS, SYSTEM_ORG_ID, type PluginCatalogField } from '@pipeline-builder/api-core';
import { Config } from '@pipeline-builder/pipeline-core';
import type { PluginListing, PluginPublishRequest, Publisher } from '@pipeline-builder/pipeline-data';

import { autoApprovalFacts, matchingRule } from './auto-approval.js';
import { bootstrapState } from './bootstrap.js';
import { effectiveMetadata, listingFieldValue, metadataRow, type RequestMetadata } from './metadata.js';
import { contractDiff, sameValue, specSnapshot, versionGates, vulnDelta } from './policy.js';
import { listings, plugins, previousVersion, requests, type PluginRow } from './store.js';
import { submissionReviewContext } from './submission-moderation.js';
import { fetchImageSbom, fetchPublicImageSbom } from '../../helpers/supply-chain.js';

const logger = createLogger('ecosystem-review');

/** `name@version` for every package in an SPDX document. */
export function sbomPackages(sbom: Record<string, unknown>): string[] {
  const pkgs = Array.isArray(sbom.packages) ? sbom.packages as Array<Record<string, unknown>> : [];
  return [...new Set(pkgs
    .map((p) => (typeof p.name === 'string' ? `${p.name}${typeof p.versionInfo === 'string' ? `@${p.versionInfo}` : ''}` : null))
    .filter((x): x is string => x !== null))].sort();
}

/** The image an SBOM delta is read for. */
interface SbomSubject { orgId: string; name: string; imageDigest: string; imageRepository?: string }

/** SBOM package delta between the previous published image and the requested one (best-effort). */
async function sbomDiff(current: SbomSubject | null, previous: { imageRepository: string | null; imageDigest: string | null } | null) {
  if (!current) return null;
  try {
    const registry = Config.get('registry');
    const now = sbomPackages(await fetchImageSbom(current, registry));
    const prior = previous?.imageRepository && previous.imageDigest
      ? sbomPackages(await fetchPublicImageSbom(previous.imageRepository, previous.imageDigest, registry)) : [];
    const prev = new Set(prior);
    const cur = new Set(now);
    return { added: now.filter((p) => !prev.has(p)), removed: prior.filter((p) => !cur.has(p)), error: null };
  } catch (err) {
    logger.debug('SBOM diff unavailable', { image: current.name, error: errorMessage(err) });
    return { added: [], removed: [], error: `The SBOM could not be read: ${errorMessage(err)}` };
  }
}

/** Per-field metadata rows: the proposed value next to the live / previous one, with provenance. */
function metadataRows(r: PluginPublishRequest, plugin: PluginRow | null, listing: PluginListing | null) {
  const payload = (r.payload ?? {}) as { metadata?: RequestMetadata };
  const proposed = payload.metadata ?? (plugin ? effectiveMetadata(plugin) : { values: {}, sources: {} });
  const fields = r.kind === 'listing_update' ? Object.keys(proposed.values) as PluginCatalogField[] : [...PLUGIN_CATALOG_FIELDS];
  return fields.map((field) => metadataRow(field, proposed.values[field] ?? null, listing ? listingFieldValue(listing, field) : null, proposed.sources[field] ?? null, listing !== null));
}

/** Whether a proposed icon is a curated vendor mark — reserved for Official listings and Verified owners of the mark. */
const isCuratedMark = (icon: unknown): boolean => !!icon && typeof icon === 'object' && 'key' in (icon as object);

/** The publisher's request history + the auto-approval verdict (shared by every review). */
async function historyAndVerdict(r: PluginPublishRequest, publisher: Publisher, listing: PluginListing | null, plugin: PluginRow | null, bump?: string | null) {
  const history = await requests.list({ publisherId: publisher.id, limit: 500 });
  const ownListings = await listings.list({ publisherId: publisher.id });
  const verdict = await matchingRule(r, publisher, listing, plugin);
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
      ...(bump ? { bump } : {}),
      bootstrapOpen: !bootstrap.closedAt && bootstrap.openedAt !== null,
    },
  };
}

/** GET /ecosystem/requests/:id → `review`. */
export async function reviewDiff(r: PluginPublishRequest, publisher: Publisher) {
  if (r.kind === 'submission') return submissionReviewDiff(r, publisher);
  const listing = r.listingId ? await listings.byId(r.listingId) : null;
  const plugin = r.pluginId ? await plugins.byId(r.pluginId) : null;
  const isVersion = (r.kind === 'new_listing' || r.kind === 'new_version') && plugin !== null;
  const prev = isVersion ? await previousVersion(listing?.id ?? null, r.version) : null;
  const current = plugin ? specSnapshot(plugin) : null;
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
    sbom: isVersion && plugin ? await sbomDiff(plugin.imageDigest ? { orgId: plugin.orgId, name: plugin.name, imageDigest: plugin.imageDigest } : null, prev) : null,
    icon: isVersion || r.kind === 'listing_update' ? (() => {
      const proposed = ((r.payload as { metadata?: RequestMetadata }).metadata?.values.icon ?? plugin?.icon ?? null);
      const previous = listing?.icon ?? null;
      return { previous, current: proposed, changed: !sameValue(proposed, previous), curatedMark: isCuratedMark(proposed) && !['official', 'verified'].includes(publisher.tier) };
    })() : null,
    gates: isVersion && plugin ? versionGates(plugin) : [],
    ...await historyAndVerdict(r, publisher, listing, plugin, facts?.bump),
  };
}

/**
 * The same review shape for an anonymous `submission` request: the
 * quarantined build against the previous APPROVED version of the same
 * community listing — metadata with provenance, contract, vulnerabilities,
 * Dockerfile, SBOM packages, icon and the recorded gate results.
 */
async function submissionReviewDiff(r: PluginPublishRequest, publisher: Publisher) {
  const { review: sub, submission: s, listing, previous: prev, facts } = await submissionReviewContext(r);
  const sbom = facts
    ? await sbomDiff({ orgId: SYSTEM_ORG_ID, name: s.name, imageDigest: facts.digest, imageRepository: facts.imageRepository }, prev)
    : null;
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
      curatedMark: isCuratedMark(proposedIcon),
    },
    gates: sub.gateReport?.gates ?? [],
    ...await historyAndVerdict(r, publisher, listing, null),
  };
}
