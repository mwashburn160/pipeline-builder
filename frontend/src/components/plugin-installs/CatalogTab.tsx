// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Library, Search } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { FilterInput } from '@/components/ui/FilterInput';
import { FilterSelect } from '@/components/ui/FilterSelect';
import { EmptyState } from '@/components/ui/EmptyState';
import { RetryError } from '@/components/ui/RetryError';
import { LoadingSpinner } from '@/components/ui/Loading';
import { RatingSummary, formatCount } from '@/components/public-directory/ListingCardView';
import { TrustTierBadge } from '@/components/public-directory/TrustTierBadge';
import { useDebounce } from '@/hooks/useDebounce';
import { useFetch } from '@/hooks/useFetch';
import api from '@/lib/api';
import { formatError } from '@/lib/constants';
import { PLUGIN_CATEGORIES, CATEGORY_DISPLAY_NAMES } from '@/lib/plugin-categories';
import { pluginPagePath } from '@/lib/public-directory/links';
import { formatReference, listingUsage } from '@/lib/plugin-installs';
import type { CatalogEntry } from '@/types/plugin-installs';
import { InstallControls } from './InstallControls';
import { InstallWarnings } from './InstallWarnings';
import { invalidate } from '@/lib/api-cache';
import { Card } from '@/components/ui/Card';

/** Listings fetched per page (the server's cap). */
const CATALOG_PAGE = 200;

/**
 * The in-app catalog: every listed listing with THIS org's install
 * state, searchable by text and category. Install actions are the same as the
 * public plugin page's; the card shows the pipeline reference to write.
 */
export function CatalogTab({
  canInstall, usage, initialQuery = '',
}: {
  canInstall: boolean;
  /** `GET /plugins/plugin-usage` counts (keyed by reference). */
  usage: Record<string, number>;
  initialQuery?: string;
}) {
  const [q, setQ] = useState(initialQuery);
  const [category, setCategory] = useState('all');
  const [installed, setInstalled] = useState<'all' | 'installed' | 'available'>('all');
  const debouncedQ = useDebounce(q, 300);

  const filters = {
    q: debouncedQ.trim() || undefined,
    category: category === 'all' ? undefined : category,
    installed: installed === 'all' ? undefined : installed === 'installed',
  };
  const catalog = useFetch(async (signal) => {
    const res = await api.getPluginCatalog({ ...filters, limit: CATALOG_PAGE }, { signal });
    return { listings: res.data?.listings ?? [], total: res.data?.total ?? res.data?.listings.length ?? 0, hasMore: !!res.data?.hasMore };
  }, [debouncedQ, category, installed]);
  // Later pages, appended by "Load more", so a listing past the server's first
  // page is reachable.
  const [more, setMore] = useState<{ listings: CatalogEntry[]; hasMore: boolean } | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);
  useEffect(() => { setMore(null); setMoreError(null); }, [catalog.data]);

  // An install changes what the pipeline editor can resolve.
  const afterChange = () => { invalidate.plugins(); void catalog.refetch(); };
  const entries = [...(catalog.data?.listings ?? []), ...(more?.listings ?? [])];
  const total = catalog.data?.total ?? entries.length;
  const hasMore = more ? more.hasMore : !!catalog.data?.hasMore;

  const loadMore = async () => {
    setLoadingMore(true);
    setMoreError(null);
    try {
      const res = await api.getPluginCatalog({ ...filters, limit: CATALOG_PAGE, offset: entries.length });
      const page = { listings: res.data?.listings ?? [], hasMore: !!res.data?.hasMore };
      setMore((m) => ({ listings: [...(m?.listings ?? []), ...page.listings], hasMore: page.hasMore }));
    } catch (err) {
      setMoreError(formatError(err, 'Could not load more of the catalog'));
    } finally {
      setLoadingMore(false);
    }
  };

  return (
    <div className="space-y-4" data-testid="catalog-tab">
      <div className="flex flex-wrap items-center gap-2">
        <FilterInput
          type="search"
          aria-label="Search the catalog"
          placeholder="Search the catalog…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          className="max-w-xs"
        />
        <FilterSelect aria-label="Catalog category" value={category} onChange={(e) => setCategory(e.target.value)}>
          <option value="all">All categories</option>
          {PLUGIN_CATEGORIES.map((c) => <option key={c} value={c}>{CATEGORY_DISPLAY_NAMES[c]}</option>)}
        </FilterSelect>
        <FilterSelect aria-label="Install state" value={installed} onChange={(e) => setInstalled(e.target.value as typeof installed)}>
          <option value="all">Installed and available</option>
          <option value="installed">Installed only</option>
          <option value="available">Not installed</option>
        </FilterSelect>
      </div>

      {catalog.error && !catalog.data ? (
        <RetryError message={formatError(catalog.error, 'Could not load the catalog')} onRetry={catalog.refetch} />
      ) : catalog.loading && !catalog.data ? (
        <div className="flex items-center gap-2 py-6 text-sm text-fg-muted"><LoadingSpinner size="sm" /> Loading the catalog…</div>
      ) : entries.length === 0 ? (
        <EmptyState
          icon={q || category !== 'all' || installed !== 'all' ? Search : Library}
          title={q || category !== 'all' || installed !== 'all' ? 'No listings match' : 'The catalog is empty'}
          description="Listings appear here once they are published to the plugin directory."
        />
      ) : (
        <ul className="grid gap-3 md:grid-cols-2" aria-label="Catalog listings">
          {entries.map((entry) => (
            <CatalogCard key={entry.listing.id} entry={entry} canInstall={canInstall} usage={usage} onChanged={afterChange} />
          ))}
        </ul>
      )}
      {entries.length > 0 && (hasMore || entries.length < total) && (
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-fg-muted" data-testid="catalog-count">
          <span>Showing {entries.length} of {total} — narrow the search, or load more.</span>
          {hasMore && <Button variant="secondary" size="xs" onClick={() => void loadMore()} loading={loadingMore}>Load more</Button>}
        </div>
      )}
      {moreError && <RetryError message={moreError} onRetry={() => void loadMore()} />}
    </div>
  );
}

function CatalogCard({ entry, canInstall, usage, onChanged }: {
  entry: CatalogEntry;
  canInstall: boolean;
  usage: Record<string, number>;
  onChanged: () => void;
}) {
  const { listing, resolved, reference } = entry;
  const used = listingUsage(listing, usage, { shadowed: !!entry.shadowedBy });
  return (
    <Card as="li" className="flex flex-col gap-3 p-4" data-testid="catalog-card">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <Link href={pluginPagePath(listing.publisherHandle, listing.name)} className="truncate font-mono text-sm font-semibold text-fg hover:text-brand hover:underline">
              {listing.name}
            </Link>
            <TrustTierBadge tier={listing.publisherTier} />
            {listing.state === 'unmaintained' && <span className="text-xs text-warning-strong">Unmaintained</span>}
          </div>
          <p className="text-xs text-fg-muted">
            by {listing.publisherDisplayName} <span className="text-fg-subtle">@{listing.publisherHandle}</span>
            {listing.latestVersion ? <> · latest v{listing.latestVersion}</> : null}
            {resolved ? <> · resolves to v{resolved.version}</> : null}
          </p>
          {listing.summary && <p className="text-sm text-fg">{listing.summary}</p>}
          {((entry.rating?.count ?? 0) > 0 || entry.installCount > 0) && (
            <p className="flex flex-wrap items-center gap-x-3 text-xs text-fg-muted" data-testid="catalog-stats">
              <RatingSummary rating={entry.rating} />
              {entry.installCount > 0 && <span>{formatCount(entry.installCount)} install{entry.installCount === 1 ? '' : 's'}</span>}
            </p>
          )}
          <p className="text-xs text-fg-subtle">
            Reference: <code className="font-mono">{formatReference(reference)}</code>
            {used > 0 && <> · used by {used} pipeline{used === 1 ? '' : 's'}</>}
          </p>
          {entry.shadowedBy && (
            <p className="text-xs text-warning-strong">
              Your organization has its own <code className="font-mono">{listing.name}</code>, so an unqualified reference uses yours.
            </p>
          )}
          {entry.install && <InstallWarnings install={entry.install} />}
        </div>
      </div>
      <InstallControls entry={entry} canInstall={canInstall} onChanged={onChanged} />
    </Card>
  );
}
