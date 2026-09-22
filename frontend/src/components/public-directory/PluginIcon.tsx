// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Plugin icons for the public directory.
 *
 * - `vendor`: a curated SVG resolved by `iconKey` from the build-time manifest,
 *   drawn as a CSS `mask-image` filled with the brand colour — or the theme's
 *   text colour where the brand colour fails 3:1 against the card. A key the
 *   manifest doesn't know (a dropped logo) falls back to the monogram.
 * - `uploaded`: a same-origin raster, as a plain `<img>`.
 * - `monogram` / fallback: letters on a hashed colour, category glyph in the corner.
 * - `category`: the category glyph.
 *
 * Icons are never inlined SVG (a file can't run script from an `<img>` or a
 * mask), and are decorative: the plugin name always sits beside them.
 * {@link PluginIdentity} pairs every icon with its trust-tier badge, so a logo
 * alone never signals trust.
 */
import type { CSSProperties } from 'react';
import { Package } from 'lucide-react';
import { PLUGIN_ICONS } from '@/generated/plugin-icons';
import { CATEGORY_ICONS } from '@/lib/plugin-category-icons';
import { isPluginCategory } from '@/lib/plugin-categories';
import { iconFills, monogramColor, monogramLetters } from '@/lib/public-directory/icon-colors';
import type { ListingCard } from '@/lib/public-directory/types';
import { TrustTierBadge } from './TrustTierBadge';

export type IconSize = 'sm' | 'md' | 'lg';

const TILE: Record<IconSize, string> = {
  sm: 'h-8 w-8 rounded-md',
  md: 'h-11 w-11 rounded-lg',
  lg: 'h-16 w-16 rounded-xl',
};
const MARK: Record<IconSize, string> = { sm: 'h-5 w-5', md: 'h-7 w-7', lg: 'h-10 w-10' };
const LETTERS: Record<IconSize, string> = { sm: 'text-xs', md: 'text-sm', lg: 'text-xl' };
const CORNER: Record<IconSize, string> = { sm: 'h-3.5 w-3.5 p-0.5', md: 'h-4 w-4 p-0.5', lg: 'h-6 w-6 p-1' };

type IconFields = Pick<ListingCard, 'name' | 'category' | 'iconKind' | 'iconKey' | 'iconUrl' | 'iconHex' | 'iconBadge'>;

/** The lucide glyph for a category id (Package for an unknown one). */
export function categoryGlyph(category: string) {
  return isPluginCategory(category) ? CATEGORY_ICONS[category] : Package;
}

/** A same-origin relative URL, or null. Uploaded icons are served by us; anything else is refused. */
function sameOriginPath(url: string | null): string | null {
  return url && url.startsWith('/') && !url.startsWith('//') ? url : null;
}

/** A curated SVG drawn as a brand-coloured mask. */
function MaskMark({ url, hex, className }: { url: string; hex: string | null; className: string }) {
  const fills = iconFills(hex);
  const style = {
    WebkitMaskImage: `url("${url}")`,
    maskImage: `url("${url}")`,
    WebkitMaskRepeat: 'no-repeat',
    maskRepeat: 'no-repeat',
    WebkitMaskPosition: 'center',
    maskPosition: 'center',
    WebkitMaskSize: 'contain',
    maskSize: 'contain',
    '--pb-icon-light': fills.light,
    '--pb-icon-dark': fills.dark,
  } as CSSProperties;
  return (
    <span
      aria-hidden="true"
      data-icon-fill-light={fills.light}
      data-icon-fill-dark={fills.dark}
      className={`block bg-[var(--pb-icon-light)] dark:bg-[var(--pb-icon-dark)] ${className}`}
      style={style}
    />
  );
}

/** A curated key's mark: a brand-coloured mask when the colour is known, else the file as an `<img>`. */
function CuratedMark({ iconKey, className }: { iconKey: string; className: string }) {
  const asset = PLUGIN_ICONS[iconKey];
  if (!asset) return null;
  return asset.hex
    ? <MaskMark url={asset.url} hex={asset.hex} className={className} />
    : <img src={asset.url} alt="" className={`object-contain ${className}`} />;
}

/** Letters on a colour hashed from the name, with the category glyph in the corner. */
export function Monogram({ name, category, size = 'md' }: { name: string; category: string; size?: IconSize }) {
  const Glyph = categoryGlyph(category);
  return (
    <span
      aria-hidden="true"
      data-testid="plugin-monogram"
      className={`relative inline-grid shrink-0 place-items-center font-semibold text-white ${TILE[size]} ${LETTERS[size]}`}
      style={{ backgroundColor: monogramColor(name) }}
    >
      {monogramLetters(name)}
      <span className={`absolute -bottom-1 -right-1 grid place-items-center rounded-full border border-default bg-surface text-fg-muted ${CORNER[size]}`}>
        <Glyph className="h-full w-full" />
      </span>
    </span>
  );
}

/** The category glyph as a tile (the last-resort plugin icon, and category cards). */
export function CategoryTile({ category, size = 'md' }: { category: string; size?: IconSize }) {
  const Glyph = categoryGlyph(category);
  return (
    <span aria-hidden="true" className={`inline-grid shrink-0 place-items-center border border-default bg-surface-muted text-fg ${TILE[size]}`}>
      <Glyph className={MARK[size]} />
    </span>
  );
}

/** The plugin's icon alone (see {@link PluginIdentity} for icon + tier). */
export function PluginIcon({ listing, size = 'md' }: { listing: IconFields; size?: IconSize }) {
  const tile = `relative inline-grid shrink-0 place-items-center border border-default bg-surface ${TILE[size]}`;

  if (listing.iconKind === 'vendor' && listing.iconKey && PLUGIN_ICONS[listing.iconKey]) {
    const badge = listing.iconBadge && PLUGIN_ICONS[listing.iconBadge] ? listing.iconBadge : null;
    return (
      <span className={tile} data-testid="plugin-icon-vendor" data-icon-key={listing.iconKey}>
        <CuratedMark iconKey={listing.iconKey} className={MARK[size]} />
        {badge && (
          <span className={`absolute -bottom-1 -right-1 grid place-items-center rounded-full border border-default bg-surface ${CORNER[size]}`}>
            <CuratedMark iconKey={badge} className="h-full w-full" />
          </span>
        )}
      </span>
    );
  }

  const uploaded = listing.iconKind === 'uploaded' ? sameOriginPath(listing.iconUrl) : null;
  if (uploaded) {
    return (
      <span className={`${tile} overflow-hidden`} data-testid="plugin-icon-uploaded">
        <img src={uploaded} alt="" className="h-full w-full object-cover" loading="lazy" decoding="async" />
      </span>
    );
  }

  if (listing.iconKind === 'category') return <CategoryTile category={listing.category} size={size} />;
  // `monogram`, and the fallback for a vendor key or upload we can't serve.
  return <Monogram name={listing.name} category={listing.category} size={size} />;
}

/** Icon and trust-tier badge, always together. */
export function PluginIdentity({ listing, size = 'md' }: {
  listing: IconFields & Pick<ListingCard, 'publisher'>;
  size?: IconSize;
}) {
  return (
    <span className="inline-flex shrink-0 items-center gap-2">
      <PluginIcon listing={listing} size={size} />
      <TrustTierBadge tier={listing.publisher.tier} compact={size === 'sm'} />
    </span>
  );
}
