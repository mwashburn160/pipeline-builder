// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import Link from 'next/link';
import { Star } from 'lucide-react';
import { categoryLabel } from '@/lib/public-directory/listing';
import { pluginPagePath } from '@/lib/public-directory/links';
import type { ListingCard } from '@/lib/public-directory/types';
import { HealthBadge } from './HealthBadge';
import { Highlighted } from './Highlighted';
import { PluginIdentity } from './PluginIcon';
import { Card } from '@/components/ui/Card';

/** `YYYY-MM-DD` in UTC — identical on the server and in the browser (no hydration drift). */
export function formatDay(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toISOString().slice(0, 10);
}

/** Compact install count: 1234 → "1.2k". */
export function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, '')}k`;
  return String(n);
}

/** "4.6 ★ (123)" — nothing at all when unrated. */
export function RatingSummary({ rating }: { rating: ListingCard['rating'] }) {
  if (!rating || rating.count === 0) return null;
  return (
    <span className="inline-flex items-center gap-1 text-xs text-fg-muted">
      <Star className="h-3.5 w-3.5 fill-current text-warning" aria-hidden="true" />
      <span>
        {rating.score.toFixed(1)}
        <span className="sr-only"> out of 5</span> ({formatCount(rating.count)}
        <span className="sr-only"> ratings</span>)
      </span>
    </span>
  );
}

/** One listing in a grid or result list. The whole card is clickable via its title link. */
export function ListingCardView({ listing, headingLevel = 3 }: { listing: ListingCard; headingLevel?: 2 | 3 }) {
  const H = headingLevel === 2 ? 'h2' : 'h3';
  const href = pluginPagePath(listing.publisher.handle, listing.name);
  return (
    <Card as="article" className="relative flex h-full flex-col gap-3 p-4 transition-shadow focus-within:ring-2 focus-within:ring-[color:var(--pb-ring)] hover:shadow-md">
      <div className="flex items-start gap-3">
        <PluginIdentity listing={listing} size="md" />
      </div>
      <div className="min-w-0">
        <H className="truncate font-mono text-sm font-semibold text-fg">
          {/* Stretched link: the card is one tab stop and one click target. */}
          <Link href={href} className="after:absolute after:inset-0 focus:outline-none">
            <Highlighted highlight={listing.highlight?.name} text={listing.name} />
          </Link>
        </H>
        <p className="truncate text-xs text-fg-muted">by {listing.publisher.displayName}</p>
      </div>
      <p className="line-clamp-2 text-sm text-fg-muted">
        <Highlighted highlight={listing.highlight?.summary} text={listing.summary} />
      </p>
      <div className="mt-auto flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-fg-subtle">
        <span className="rounded-full bg-surface-muted px-2 py-0.5 text-fg-muted">{categoryLabel(listing.category)}</span>
        <span className="font-mono">v{listing.latestVersion}</span>
        <RatingSummary rating={listing.rating} />
        {listing.installCount > 0 && <span>{formatCount(listing.installCount)} installs</span>}
        <HealthBadge score={listing.healthScore} />
        {listing.state === 'unmaintained' && (
          <span className="rounded-full bg-warning-bg px-2 py-0.5 font-medium text-warning-strong">Unmaintained</span>
        )}
      </div>
    </Card>
  );
}

/** A responsive grid of listing cards. */
export function ListingGrid({ items, headingLevel = 3 }: { items: ListingCard[]; headingLevel?: 2 | 3 }) {
  return (
    <ul className="grid list-none gap-4 p-0 sm:grid-cols-2 xl:grid-cols-3">
      {items.map((item) => (
        <li key={`${item.publisher.handle}/${item.name}`}>
          <ListingCardView listing={item} headingLevel={headingLevel} />
        </li>
      ))}
    </ul>
  );
}
