// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `/plugins` — the public plugin directory.
 *
 * With no filters it is the directory home (search, category grid, featured
 * Official, recently updated); with any filter the same page renders results.
 * The URL is the query: server-rendered, shareable, indexable, and working with
 * JavaScript off. Typing re-navigates (debounced), which re-runs
 * `getServerSideProps` — there is no second, client-side fetch path.
 */
import Link from 'next/link';
import { useRouter } from 'next/router';
import type { GetServerSideProps } from 'next';
import { SearchX } from 'lucide-react';
import { PublicLayout, DirectoryHead } from '@/components/public-directory/PublicLayout';
import { DirectorySearch } from '@/components/public-directory/DirectorySearch';
import { CategoryGrid } from '@/components/public-directory/CategoryGrid';
import { ListingGrid } from '@/components/public-directory/ListingCardView';
import { FacetPanel, SortBar } from '@/components/public-directory/Facets';
import { Callout } from '@/components/ui/Callout';
import { resolveSiteUrl, type WithSiteUrl } from '@/lib/site-url';
import { CATEGORY_DISPLAY_NAMES, PLUGIN_CATEGORIES } from '@/lib/plugin-categories';
import { getCategories, searchListings } from '@/lib/public-directory/api';
import {
  directoryHref, directorySeo, isFilteredQuery, parseDirectoryQuery, withParam, type DirectoryQuery,
} from '@/lib/public-directory/query';
import { cachePublicly, markUnavailable } from '@/lib/public-directory/server';
import { categoryPagePath, loginHref } from '@/lib/public-directory/links';
import type { CategorySummary, ListingCard, SearchResult } from '@/lib/public-directory/types';
import { Card } from '@/components/ui/Card';

const HOME_SECTION_SIZE = 6;
const RESULTS_PAGE_SIZE = 24;

export type DirectoryPageProps = WithSiteUrl & { query: DirectoryQuery } & (
  | { mode: 'home'; categories: CategorySummary[]; featured: ListingCard[]; recent: ListingCard[] }
  | { mode: 'results'; results: SearchResult }
  | { mode: 'unavailable' }
);

const DESCRIPTION = 'Browse and search Pipeline Builder plugins: build, security, testing, deploy and notification steps you can drop into any pipeline.';

function Unavailable() {
  return (
    <Callout variant="warning" title="The plugin directory is unavailable right now">
      Please try again in a minute.
    </Callout>
  );
}

function NoResults({ query }: { query: DirectoryQuery }) {
  const router = useRouter();
  return (
    <Card className="flex flex-col items-center gap-4 p-8 text-center">
      <SearchX className="h-8 w-8 text-fg-subtle" aria-hidden="true" />
      <div>
        <h2 className="text-lg font-semibold text-fg">No plugins match{query.q ? <> “{query.q}”</> : ' these filters'}</h2>
        <p className="mt-1 text-sm text-fg-muted">Try fewer words, or browse by category.</p>
      </div>
      <ul className="flex flex-wrap justify-center gap-2" aria-label="Browse by category">
        {PLUGIN_CATEGORIES.map((id) => (
          <li key={id}>
            <Link href={categoryPagePath(id)} className="rounded-full bg-surface-muted px-3 py-1 text-sm text-fg-muted hover:text-fg">
              {CATEGORY_DISPLAY_NAMES[id]}
            </Link>
          </li>
        ))}
      </ul>
      <p className="text-sm text-fg-muted">
        Can’t find what you need?{' '}
        {/* No account needed. The submit page itself explains when this instance has submissions turned off. */}
        <Link href="/plugins/submit" className="action-link">Submit a plugin</Link>
        {' '}or{' '}
        <Link href={loginHref(router.asPath)} className="action-link">sign in</Link> to publish from your organization.
      </p>
    </Card>
  );
}

function Results({ query, results }: { query: DirectoryQuery; results: SearchResult }) {
  const showRating = results.items.some((i) => i.rating && i.rating.count > 0);
  return (
    <div className="grid gap-8 lg:grid-cols-[14rem_1fr]">
      <aside className="order-2 lg:order-1">
        <FacetPanel facets={results.facets} query={query} showRating={showRating} />
      </aside>
      <section className="order-1 min-w-0 space-y-4 lg:order-2" aria-labelledby="results-heading">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="results-heading" className="sr-only">Results</h2>
          <p role="status" aria-live="polite" className="text-sm text-fg-muted">
            {results.total} {results.total === 1 ? 'plugin' : 'plugins'}{query.q ? <> for “{query.q}”</> : null}
          </p>
          <SortBar query={query} />
        </div>
        {results.items.length === 0 ? <NoResults query={query} /> : <ListingGrid items={results.items} />}
        {(results.nextCursor || query.cursor) && (
          <nav aria-label="Pages" className="flex justify-between pt-2 text-sm">
            {query.cursor ? <Link href={directoryHref(withParam(query, 'cursor', undefined))} className="action-link">← First page</Link> : <span />}
            {results.nextCursor && (
              <Link href={directoryHref({ ...query, cursor: results.nextCursor })} className="action-link">Next page →</Link>
            )}
          </nav>
        )}
      </section>
    </div>
  );
}

function Home({ categories, featured, recent }: { categories: CategorySummary[]; featured: ListingCard[]; recent: ListingCard[] }) {
  return (
    <div className="space-y-10">
      <section aria-labelledby="categories-heading" className="space-y-4">
        <h2 id="categories-heading" className="text-xl font-semibold text-fg">Browse by category</h2>
        <CategoryGrid categories={categories} />
      </section>
      {featured.length > 0 && (
        <section aria-labelledby="featured-heading" className="space-y-4">
          <div className="flex items-baseline justify-between">
            <h2 id="featured-heading" className="text-xl font-semibold text-fg">Featured Official plugins</h2>
            <Link href={directoryHref({ tier: 'official' })} className="action-link text-sm">All Official</Link>
          </div>
          <ListingGrid items={featured} />
        </section>
      )}
      {recent.length > 0 && (
        <section aria-labelledby="recent-heading" className="space-y-4">
          <div className="flex items-baseline justify-between">
            <h2 id="recent-heading" className="text-xl font-semibold text-fg">Recently updated</h2>
            <Link href={directoryHref({ sort: 'updated' })} className="action-link text-sm">See all</Link>
          </div>
          <ListingGrid items={recent} />
        </section>
      )}
      {/* The way IN to the directory, on the page people actually land on. This
          used to appear only in NoResults — i.e. you had to search for something
          that did not exist before the platform told you how to contribute. Both
          sections above hide themselves when empty, so on a new instance the
          landing page was a category grid and nothing else. */}
      <p className="text-sm text-fg-muted">
        Have a plugin to share?{' '}
        {/* No account needed. The submit page itself explains when this instance has submissions turned off. */}
        <Link href="/plugins/submit" className="action-link">Submit a plugin</Link>
        {' '}— no account needed — or{' '}
        <Link href={loginHref('/plugins')} className="action-link">sign in</Link> to publish from your organization.
      </p>
    </div>
  );
}

export default function PluginDirectoryPage(props: DirectoryPageProps) {
  const { siteUrl, query } = props;
  const seo = directorySeo(query);
  const canonical = `${siteUrl}${seo.canonicalPath}`;
  return (
    <PublicLayout>
      <DirectoryHead
        title={query.q ? `“${query.q}” — Plugins` : 'Plugin directory'}
        description={DESCRIPTION}
        canonical={canonical}
        siteUrl={siteUrl}
        noindex={props.mode === 'unavailable' || seo.noindex}
      />
      <div className="mb-8 space-y-4">
        <div>
          <h1 className="text-3xl font-bold text-fg">Plugin directory</h1>
          <p className="mt-1 text-fg-muted">Reusable, signed build steps for your pipelines.</p>
        </div>
        {/* Same position in every mode, so typing never remounts (and never loses focus). */}
        <DirectorySearch query={query} />
      </div>
      {props.mode === 'unavailable' && <Unavailable />}
      {props.mode === 'results' && <Results query={query} results={props.results} />}
      {props.mode === 'home' && <Home categories={props.categories} featured={props.featured} recent={props.recent} />}
    </PublicLayout>
  );
}

export const getServerSideProps: GetServerSideProps<DirectoryPageProps> = async ({ query: raw, res }) => {
  const siteUrl = resolveSiteUrl();
  const query = parseDirectoryQuery(raw);

  if (isFilteredQuery(query) || query.sort || query.cursor) {
    const results = await searchListings(query, RESULTS_PAGE_SIZE);
    if (!results.ok && results.notFound) return { notFound: true };
    if (!results.ok) {
      markUnavailable(res);
      return { props: { siteUrl, query, mode: 'unavailable' } };
    }
    cachePublicly(res);
    return { props: { siteUrl, query, mode: 'results', results: results.data } };
  }

  const [categories, featured, recent] = await Promise.all([
    getCategories(),
    searchListings({ tier: 'official', sort: 'installs' }, HOME_SECTION_SIZE),
    searchListings({ sort: 'updated' }, HOME_SECTION_SIZE),
  ]);
  if ([categories, featured, recent].some((r) => !r.ok && r.notFound)) return { notFound: true };
  if (!categories.ok || !featured.ok || !recent.ok) {
    markUnavailable(res);
    return { props: { siteUrl, query, mode: 'unavailable' } };
  }
  cachePublicly(res);
  return {
    props: {
      siteUrl,
      query,
      mode: 'home',
      categories: categories.data.categories,
      featured: featured.data.items,
      recent: recent.data.items,
    },
  };
};
