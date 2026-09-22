// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `/plugins/[publisher]/[name]` — a plugin's public page (§6a "Plugin page").
 *
 * Server-rendered and CDN-cached; the tab is part of the URL (`?tab=`), so every
 * tab works without JavaScript and can be linked. The only viewer-dependent bit
 * — the org's install state and actions vs "Sign in to install" — renders after mount.
 */
import Link from 'next/link';
import type { GetServerSideProps } from 'next';
import Head from 'next/head';
import { ArrowLeft, ExternalLink } from 'lucide-react';
import { PublicLayout, DirectoryHead } from '@/components/public-directory/PublicLayout';
import { PluginIdentity } from '@/components/public-directory/PluginIcon';
import { RatingSummary, formatCount, formatDay } from '@/components/public-directory/ListingCardView';
import { useClientAuth } from '@/components/public-directory/PublicHeader';
import { AdvisoryBanner } from '@/components/public-directory/AdvisoryBanner';
import { HealthBadge, HealthBreakdownPanel } from '@/components/public-directory/HealthBadge';
import {
  ConfigurationPanel, LISTING_TAB_LABELS, OverviewPanel, ReviewsPanel, SupplyChainPanel, VersionsPanel,
  LISTING_TABS, type ListingTab,
} from '@/components/public-directory/ListingTabs';
import { TabBar } from '@/components/ui/TabBar';
import { Callout } from '@/components/ui/Callout';
import { CodeBlock } from '@/components/ui/CodeBlock';
import { resolveSiteUrl, type WithSiteUrl } from '@/lib/site-url';
import { getListing } from '@/lib/public-directory/api';
import { cachePublicly, markUnavailable } from '@/lib/public-directory/server';
import {
  categoryPagePath, loginHref, pipelineSnippet, pluginPagePath, safeExternalUrl,
} from '@/lib/public-directory/links';
import { categoryLabel, pluginJsonLd, vendorDisclaimer } from '@/lib/public-directory/listing';
import { OFFICIAL_PUBLISHER, type ListingDetail } from '@/lib/public-directory/types';
import { InstallControls } from '@/components/plugin-installs/InstallControls';
import { useFetch } from '@/hooks/useFetch';
import api from '@/lib/api';

export type PluginPageProps = WithSiteUrl & (
  | { listing: ListingDetail; tab: ListingTab; unavailable?: false }
  | { listing: null; tab: ListingTab; unavailable: true; publisher: string; name: string }
);

function InstallAction({ listing, path }: { listing: ListingDetail; path: string }) {
  const { signedIn } = useClientAuth();
  const official = listing.publisher.handle === OFFICIAL_PUBLISHER;
  if (signedIn) return <SignedInInstall listing={listing} />;
  return (
    <div className="flex flex-col items-start gap-1 sm:items-end">
      <Link href={loginHref(path)} className="btn btn-primary px-4 py-2 text-sm">Sign in to install</Link>
      {official && <p className="text-xs text-fg-subtle">Official plugins are available in every workspace — no install needed.</p>}
    </div>
  );
}

/**
 * The signed-in viewer's install state for this listing in their active org
 * (client-only, after mount — the SSR HTML stays the guest's and cacheable).
 * If the state can't be read, the page still offers the in-app catalog.
 */
function SignedInInstall({ listing }: { listing: ListingDetail }) {
  const state = useFetch(
    async (signal) => (await api.getListingInstallState(listing.publisher.handle, listing.name, { signal })).data ?? null,
    [listing.publisher.handle, listing.name],
  );
  const catalogHref = `/dashboard/plugins?tab=catalog&q=${encodeURIComponent(listing.name)}`;
  if (state.loading && !state.data) {
    return <div className="text-sm text-fg-subtle" aria-busy="true">Checking your organization…</div>;
  }
  if (!state.data) {
    return (
      <div className="flex flex-col items-start gap-1 sm:items-end">
        <Link href={catalogHref} className="btn btn-primary px-4 py-2 text-sm">Open in your catalog</Link>
      </div>
    );
  }
  return (
    <div className="flex flex-col items-start gap-1 sm:items-end">
      <InstallControls entry={state.data.entry} canInstall={state.data.canInstall} align="end" onChanged={state.refetch} />
      <Link href={catalogHref} className="action-link text-xs">Manage in your catalog</Link>
    </div>
  );
}

function PluginPageBody({ listing, tab, siteUrl }: { listing: ListingDetail; tab: ListingTab; siteUrl: string }) {
  const path = pluginPagePath(listing.publisher.handle, listing.name);
  const url = `${siteUrl}${path}`;
  const disclaimer = vendorDisclaimer(listing);
  const homepage = safeExternalUrl(listing.homepageUrl);
  const source = safeExternalUrl(listing.sourceUrl);
  const tabs = LISTING_TABS;
  const active: ListingTab = tabs.includes(tab) ? tab : 'overview';

  return (
    <>
      <DirectoryHead
        title={`${listing.name} by ${listing.publisher.displayName}`}
        description={listing.summary}
        canonical={url}
        siteUrl={siteUrl}
      />
      <Head>
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: pluginJsonLd(listing, url) }} />
      </Head>
      <nav aria-label="Breadcrumb" className="mb-4 flex flex-wrap items-center gap-2 text-sm">
        <Link href="/plugins" className="action-link inline-flex items-center gap-1"><ArrowLeft className="h-4 w-4" aria-hidden="true" /> Plugins</Link>
        <span className="text-fg-subtle" aria-hidden="true">/</span>
        <Link href={categoryPagePath(listing.category)} className="action-link">{categoryLabel(listing.category)}</Link>
      </nav>

      <header className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-start">
        <PluginIdentity listing={listing} size="lg" />
        <div className="min-w-0 flex-1 space-y-1">
          <h1 className="break-words font-mono text-2xl font-bold text-fg">{listing.name}</h1>
          <p className="text-sm text-fg-muted">
            by <span className="font-medium text-fg">{listing.publisher.displayName}</span>{' '}
            <span className="text-fg-subtle">@{listing.publisher.handle}</span>
          </p>
          <p className="text-fg">{listing.summary}</p>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 pt-1 text-xs text-fg-subtle">
            <span className="font-mono">v{listing.latestVersion}</span>
            <span>{listing.license}</span>
            <span>Updated {formatDay(listing.updatedAt)}</span>
            <RatingSummary rating={listing.rating} />
            {listing.installCount > 0 && <span>{formatCount(listing.installCount)} installs</span>}
            <HealthBadge score={listing.healthScore} />
            {homepage && <a href={homepage} className="action-link inline-flex items-center gap-1" rel="nofollow noopener noreferrer">Homepage <ExternalLink className="h-3 w-3" aria-hidden="true" /></a>}
            {source && <a href={source} className="action-link inline-flex items-center gap-1" rel="nofollow noopener noreferrer">Source <ExternalLink className="h-3 w-3" aria-hidden="true" /></a>}
          </div>
          {disclaimer && <p className="pt-1 text-xs text-fg-subtle" data-testid="vendor-disclaimer">{disclaimer}</p>}
        </div>
        <InstallAction listing={listing} path={path} />
      </header>

      <div className="mb-6 space-y-3">
        <AdvisoryBanner advisories={listing.advisories} />
        {listing.state === 'unmaintained' && (
          <Callout variant="warning" title="This plugin is unmaintained">
            It still works, but it isn’t receiving updates or security fixes. Consider an alternative in{' '}
            <Link href={categoryPagePath(listing.category)} className="underline">{categoryLabel(listing.category)}</Link>.
          </Callout>
        )}
      </div>

      <div className="mb-8">
        <HealthBreakdownPanel score={listing.healthScore} breakdown={listing.healthBreakdown} successRate30d={listing.successRate30d} />
      </div>

      <section aria-labelledby="use-heading" className="mb-8 space-y-2">
        <h2 id="use-heading" className="text-sm font-semibold text-fg">Use it in a pipeline</h2>
        <CodeBlock code={pipelineSnippet(listing.publisher.handle, listing.name, listing.latestVersion)} language="yaml" />
      </section>

      <TabBar
        ariaLabel="Plugin details"
        activeId={active}
        items={tabs.map((t) => ({ id: t, label: LISTING_TAB_LABELS[t], href: t === 'overview' ? path : `${path}?tab=${t}` }))}
      />
      <div id="tab-content">
        {active === 'overview' && <OverviewPanel listing={listing} />}
        {active === 'versions' && <VersionsPanel listing={listing} />}
        {active === 'configuration' && <ConfigurationPanel listing={listing} />}
        {active === 'supply-chain' && <SupplyChainPanel listing={listing} />}
        {active === 'reviews' && <ReviewsPanel listing={listing} />}
      </div>
    </>
  );
}

export default function PluginPage(props: PluginPageProps) {
  return (
    <PublicLayout>
      {props.listing
        ? <PluginPageBody listing={props.listing} tab={props.tab} siteUrl={props.siteUrl} />
        : (
          <>
            <DirectoryHead
              title={props.name}
              description="Pipeline Builder plugin"
              canonical={`${props.siteUrl}${pluginPagePath(props.publisher, props.name)}`}
              siteUrl={props.siteUrl}
              noindex
            />
            <Callout variant="warning" title="The plugin directory is unavailable right now">Please try again in a minute.</Callout>
          </>
        )}
    </PublicLayout>
  );
}

function parseTab(raw: unknown): ListingTab {
  const t = Array.isArray(raw) ? raw[0] : raw;
  return typeof t === 'string' && t in LISTING_TAB_LABELS ? (t as ListingTab) : 'overview';
}

const SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export const getServerSideProps: GetServerSideProps<PluginPageProps> = async ({ params, query, res }) => {
  const publisher = params?.publisher;
  const name = params?.name;
  if (typeof publisher !== 'string' || typeof name !== 'string' || !SEGMENT_RE.test(publisher) || !SEGMENT_RE.test(name)) {
    return { notFound: true };
  }
  const siteUrl = resolveSiteUrl();
  const tab = parseTab(query.tab);
  const result = await getListing(publisher, name);
  if (!result.ok && result.notFound) return { notFound: true };
  if (!result.ok) {
    markUnavailable(res);
    return { props: { siteUrl, listing: null, tab, unavailable: true, publisher, name } };
  }
  cachePublicly(res);
  return { props: { siteUrl, listing: result.data.listing, tab } };
};
