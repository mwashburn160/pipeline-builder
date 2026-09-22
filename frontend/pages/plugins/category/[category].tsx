// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `/plugins/category/[category]` — a category landing page: what the category
 * is for, where it fits in a pipeline, a link to its docs, and its plugins
 * (with the non-category facets and sorts, all as links).
 */
import Link from 'next/link';
import type { GetServerSideProps } from 'next';
import { ArrowLeft, ExternalLink } from 'lucide-react';
import { PublicLayout, DirectoryHead } from '@/components/public-directory/PublicLayout';
import { DirectorySearch } from '@/components/public-directory/DirectorySearch';
import { ListingGrid } from '@/components/public-directory/ListingCardView';
import { FacetPanel, SortBar } from '@/components/public-directory/Facets';
import { CategoryTile } from '@/components/public-directory/PluginIcon';
import { Callout } from '@/components/ui/Callout';
import { resolveSiteUrl, type WithSiteUrl } from '@/lib/site-url';
import {
  CATEGORY_DESCRIPTIONS, CATEGORY_DISPLAY_NAMES, CATEGORY_STAGES, isPluginCategory, type PluginCategory,
} from '@/lib/plugin-categories';
import { searchListings } from '@/lib/public-directory/api';
import { directorySeo, parseDirectoryQuery, toSearchString, withParam, type DirectoryQuery } from '@/lib/public-directory/query';
import { cachePublicly, markUnavailable } from '@/lib/public-directory/server';
import { categoryDocUrl, categoryPagePath } from '@/lib/public-directory/links';
import type { SearchResult } from '@/lib/public-directory/types';

const PAGE_SIZE = 48;

export type CategoryPageProps = WithSiteUrl & {
  category: PluginCategory;
  query: DirectoryQuery;
  results: SearchResult | null;
};

export default function CategoryPage({ siteUrl, category, query, results }: CategoryPageProps) {
  const name = CATEGORY_DISPLAY_NAMES[category];
  // Links on this page stay on this page: the category lives in the path, not the query.
  const hrefFor = (q: DirectoryQuery) => {
    const rest = { ...q };
    delete rest.category;
    return `${categoryPagePath(category)}${toSearchString(rest)}`;
  };
  const pageQuery = { ...query, category };
  const showRating = !!results?.items.some((i) => i.rating && i.rating.count > 0);

  return (
    <PublicLayout>
      <DirectoryHead
        title={`${name} plugins`}
        description={CATEGORY_DESCRIPTIONS[category]}
        canonical={`${siteUrl}${categoryPagePath(category)}`}
        siteUrl={siteUrl}
        // The category page itself is indexed; a search, facet, sort or later
        // page within it is a view of it (see `directorySeo`).
        noindex={!results || directorySeo({ ...query, category: undefined }).noindex}
      />
      <Link href="/plugins" className="action-link mb-4 inline-flex items-center gap-1 text-sm">
        <ArrowLeft className="h-4 w-4" aria-hidden="true" /> All plugins
      </Link>
      <header className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-start">
        <CategoryTile category={category} size="lg" />
        <div className="min-w-0 flex-1 space-y-2">
          <h1 className="text-3xl font-bold text-fg">{name}</h1>
          <p className="text-fg-muted">{CATEGORY_DESCRIPTIONS[category]}</p>
          <dl className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
            <div className="flex gap-1.5">
              <dt className="text-fg-subtle">Where it fits:</dt>
              <dd className="font-medium text-fg">{CATEGORY_STAGES[category]}</dd>
            </div>
            <div>
              <dt className="sr-only">Documentation</dt>
              <dd>
                <a href={categoryDocUrl(category)} className="action-link inline-flex items-center gap-1" rel="noopener noreferrer">
                  {name} plugin docs <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                </a>
              </dd>
            </div>
          </dl>
        </div>
      </header>
      <div className="mb-6">
        {/* Submits to /plugins with the category kept; not live (a keystroke would leave this page). */}
        <DirectorySearch query={pageQuery} live={false} />
      </div>
      {!results ? (
        <Callout variant="warning" title="The plugin directory is unavailable right now">Please try again in a minute.</Callout>
      ) : (
        <div className="grid gap-8 lg:grid-cols-[14rem_1fr]">
          <aside className="order-2 lg:order-1">
            <FacetPanel facets={results.facets} query={query} showRating={showRating} hrefFor={hrefFor} hideCategory />
          </aside>
          <section className="order-1 min-w-0 space-y-4 lg:order-2" aria-labelledby="category-results">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 id="category-results" className="sr-only">{name} plugins</h2>
              <p role="status" aria-live="polite" className="text-sm text-fg-muted">
                {results.total} {results.total === 1 ? 'plugin' : 'plugins'}
              </p>
              <SortBar query={query} hrefFor={hrefFor} />
            </div>
            {results.items.length === 0
              ? <p className="card p-6 text-sm text-fg-muted">No {name} plugins match these filters.</p>
              : <ListingGrid items={results.items} />}
            {(results.nextCursor || query.cursor) && (
              <nav aria-label="Pages" className="flex justify-between pt-2 text-sm">
                {query.cursor ? <Link href={hrefFor(withParam(query, 'cursor', undefined))} className="action-link">← First page</Link> : <span />}
                {results.nextCursor && <Link href={hrefFor({ ...query, cursor: results.nextCursor })} className="action-link">Next page →</Link>}
              </nav>
            )}
          </section>
        </div>
      )}
    </PublicLayout>
  );
}

export const getServerSideProps: GetServerSideProps<CategoryPageProps> = async ({ params, query: raw, res }) => {
  const category = params?.category;
  if (!isPluginCategory(category)) return { notFound: true };
  const query = parseDirectoryQuery(raw);
  delete query.category;
  delete query.q;
  const siteUrl = resolveSiteUrl();

  const results = await searchListings({ ...query, category }, PAGE_SIZE);
  if (!results.ok && results.notFound) return { notFound: true };
  if (!results.ok) {
    markUnavailable(res);
    return { props: { siteUrl, category, query, results: null } };
  }
  cachePublicly(res);
  return { props: { siteUrl, category, query, results: results.data } };
};
