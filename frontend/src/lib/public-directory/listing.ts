// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/** Derivations from a listing shared by the directory pages (labels, legal note, SEO). */
import { PLUGIN_ICONS } from '@/generated/plugin-icons';
import { CATEGORY_DISPLAY_NAMES, isPluginCategory } from '@/lib/plugin-categories';
import type { ListingDetail } from './types';

export function categoryLabel(category: string): string {
  return isPluginCategory(category) ? CATEGORY_DISPLAY_NAMES[category] : category;
}

/**
 * Nominative-use note for a vendor logo: shown unless the publisher IS
 * the vendor. A Verified publisher may only use curated keys it owns, so a
 * vendor icon on a Verified listing is the vendor's own; on any other tier
 * (Official included — the platform team is not Snyk) it is someone else's mark.
 */
export function vendorDisclaimer(listing: Pick<ListingDetail, 'iconKind' | 'iconKey' | 'publisher'>): string | null {
  if (listing.iconKind !== 'vendor' || !listing.iconKey || listing.publisher.tier === 'verified') return null;
  const asset = PLUGIN_ICONS[listing.iconKey];
  if (!asset) return null; // No logo shown (monogram fallback), nothing to disclaim.
  const vendor = asset.name ?? listing.iconKey.replace(/(^|-)([a-z])/g, (_, sep: string, c: string) => `${sep ? ' ' : ''}${c.toUpperCase()}`);
  return `Not affiliated with or endorsed by ${vendor}.`;
}

/** JSON-LD for a plugin, safe to inline in a `<script>` (`<` is escaped). */
export function pluginJsonLd(listing: ListingDetail, url: string): string {
  const data: Record<string, unknown> = {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: listing.name,
    description: listing.summary,
    applicationCategory: 'DeveloperApplication',
    applicationSubCategory: categoryLabel(listing.category),
    operatingSystem: 'Linux',
    softwareVersion: listing.latestVersion,
    license: listing.license,
    url,
    dateModified: listing.updatedAt,
    author: { '@type': 'Organization', name: listing.publisher.displayName },
    offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
  };
  if (listing.rating && listing.rating.count > 0) {
    data.aggregateRating = { '@type': 'AggregateRating', ratingValue: listing.rating.score, ratingCount: listing.rating.count };
  }
  return JSON.stringify(data).replace(/</g, '\\u003c');
}

