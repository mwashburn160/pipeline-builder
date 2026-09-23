// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared vocabulary for the plugin-ecosystem screens (the tenant Publisher page
 * and the system org's Ecosystem console): labels, badge colours, and the
 * card-preview builder the publish form uses.
 */

import type { BadgeColor } from '@/components/ui/Badge';
import { PLUGIN_ICONS } from '@/generated/plugin-icons';
import { PROJECT_REPO_URL } from '@/lib/public-directory/links';
import type { ListingCard } from '@/lib/public-directory/types';
import type { PluginCatalogEdits, PluginCatalogField, PluginIcon } from '@/types';
import type {
  ListingState, ListingsQuota, PublisherTier, PublishRequestKind, PublishRequestStatus,
} from '@/types/ecosystem';


/** Staff runbook for moderation (repo docs; runbooks are not on the in-app help site). */
export const ECOSYSTEM_RUNBOOK_URL = `${PROJECT_REPO_URL}/blob/main/docs/runbooks/ecosystem-moderation.md`;

export const REQUEST_KIND_LABELS: Record<PublishRequestKind, string> = {
  new_listing: 'New listing',
  new_version: 'New version',
  listing_update: 'Listing update',
  yank: 'Yank',
  unpause: 'Unpause',
  transfer: 'Transfer',
  claim: 'Handle claim',
  profile_change: 'Profile change',
  verify: 'Verified application',
  moderation: 'Moderation',
  advisory: 'Advisory',
  submission: 'Community submission',
};

export const REQUEST_STATUS_LABELS: Record<PublishRequestStatus, string> = {
  pending: 'Pending',
  pending_second_approval: 'Awaiting second approval',
  approved: 'Approved',
  rejected: 'Rejected',
  withdrawn: 'Withdrawn',
};

export const REQUEST_STATUS_COLORS: Record<PublishRequestStatus, BadgeColor> = {
  pending: 'yellow',
  pending_second_approval: 'indigo',
  approved: 'green',
  rejected: 'red',
  withdrawn: 'gray',
};

export const LISTING_STATE_LABELS: Record<ListingState, string> = {
  listed: 'Listed',
  unmaintained: 'Unmaintained',
  suspended: 'Suspended',
  transferred: 'Transferred',
};

export const LISTING_STATE_COLORS: Record<ListingState, BadgeColor> = {
  listed: 'green',
  unmaintained: 'yellow',
  suspended: 'red',
  transferred: 'gray',
};

/** Moderation actions a system-org `moderation` request carries (two-person). */
export const MODERATION_ACTION_LABELS: Record<string, string> = {
  unyank: 'Unyank a version',
  unsuspend_publisher: 'Lift a publisher suspension',
  relist: 'Lift a listing suspension',
  tier_verified: 'Make publisher Verified',
};

/** Is a request still open (a decision or a withdrawal is possible)? */
export function isOpenRequest(status: PublishRequestStatus): boolean {
  return status === 'pending' || status === 'pending_second_approval';
}

/** "3 of 10", "3 (unlimited)". */
export function formatListingsQuota(q: ListingsQuota): string {
  return q.limit < 0 ? `${q.used} (unlimited)` : `${q.used} of ${q.limit}`;
}

/** Has the quota run out (never, when unlimited)? */
export function isListingsQuotaFull(q: ListingsQuota): boolean {
  return q.limit >= 0 && q.used >= q.limit;
}

/** Catalog values with the user's edits laid over the detected ones (`null` clears). */
export function applyCatalogEdits(
  detected: ReadonlyArray<{ field: PluginCatalogField; value: unknown }>,
  edits: PluginCatalogEdits,
): Partial<Record<PluginCatalogField, unknown>> {
  const out: Partial<Record<PluginCatalogField, unknown>> = {};
  for (const f of detected) out[f.field] = f.value;
  for (const [k, v] of Object.entries(edits)) out[k as PluginCatalogField] = v;
  return out;
}

function iconKeyOf(value: unknown): { key: string | null; badge: string | null } {
  if (typeof value === 'string' && value) return { key: value, badge: null };
  if (value && typeof value === 'object' && typeof (value as PluginIcon).key === 'string') {
    const icon = value as PluginIcon;
    return { key: icon.key, badge: icon.badge ?? null };
  }
  return { key: null, badge: null };
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/**
 * The directory card the listing WOULD render as, built
 * from the effective catalog values — the same `ListingCard` shape the public
 * directory's card renders, so the preview can't drift from the real thing.
 * An icon key the curated manifest doesn't know falls back to the monogram,
 * exactly as the directory does.
 */
export function buildPreviewCard(input: {
  name: string;
  version: string;
  values: Partial<Record<PluginCatalogField, unknown>>;
  publisher: { handle: string; displayName: string; tier: PublisherTier } | null;
}): ListingCard {
  const { key, badge } = iconKeyOf(input.values.icon);
  const vendor = !!key && !!PLUGIN_ICONS[key];
  const keywords = Array.isArray(input.values.keywords) ? input.values.keywords.filter((k): k is string => typeof k === 'string') : [];
  return {
    publisher: input.publisher ?? { handle: 'your-handle', displayName: 'Your publisher', tier: 'community' },
    name: input.name,
    summary: str(input.values.summary) || str(input.values.description),
    category: str(input.values.category) || 'other',
    keywords,
    latestVersion: input.version,
    license: str(input.values.license),
    iconUrl: null,
    iconKind: vendor ? 'vendor' : 'monogram',
    iconKey: vendor ? key : null,
    iconHex: null,
    iconBadge: vendor ? badge : null,
    rating: null,
    installCount: 0,
    updatedAt: new Date(0).toISOString(),
    state: 'listed',
  };
}
