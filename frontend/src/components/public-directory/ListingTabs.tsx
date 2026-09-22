// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/** The plugin page's tab panels. */
import { CheckCircle2, Download, XCircle } from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import { safeExternalUrl, versionSbomPath } from '@/lib/public-directory/links';
import type { ListingDetail, RatingBucket, ReviewPage } from '@/lib/public-directory/types';
import { ReviewsSection } from '@/components/reviews/ReviewsSection';
import { formatDay } from './ListingCardView';
import { VersionAdvisoryMarker } from './AdvisoryBanner';

export const LISTING_TABS = ['overview', 'versions', 'configuration', 'supply-chain', 'reviews'] as const;
export type ListingTab = typeof LISTING_TABS[number];

export const LISTING_TAB_LABELS: Record<ListingTab, string> = {
  overview: 'Overview',
  versions: 'Versions',
  configuration: 'Configuration',
  'supply-chain': 'Supply chain',
  reviews: 'Reviews',
};

function Empty({ children }: { children: string }) {
  return <p className="text-sm text-fg-muted">{children}</p>;
}

/** README: server-rendered, server-SANITIZED HTML (rehype-sanitize allowlist). Injected as-is. */
export function OverviewPanel({ listing }: { listing: ListingDetail }) {
  if (listing.readmeHtml) {
    return <div className="pb-readme" data-testid="readme" dangerouslySetInnerHTML={{ __html: listing.readmeHtml }} />;
  }
  return <p className="whitespace-pre-line text-sm text-fg">{listing.description || listing.summary}</p>;
}

function VulnCounts({ critical, high }: { critical: number | null; high: number | null }) {
  if (critical == null && high == null) return <span className="text-fg-subtle">Not scanned</span>;
  const clean = !critical && !high;
  return (
    <span className={clean ? 'text-success-strong' : 'text-danger-strong'}>
      {critical ?? 0} critical · {high ?? 0} high
    </span>
  );
}

export function VersionsPanel({ listing }: { listing: ListingDetail }) {
  if (listing.versions.length === 0) return <Empty>No versions are listed.</Empty>;
  return (
    <ol className="divide-y divide-default">
      {listing.versions.map((v) => (
        <li key={v.version} className="space-y-1 py-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className={`font-mono text-sm font-semibold ${v.yanked ? 'text-fg-subtle line-through' : 'text-fg'}`}>{v.version}</span>
            {v.version === listing.latestVersion && <Badge color="blue">Latest</Badge>}
            {v.breaking && <Badge color="purple">Breaking</Badge>}
            {v.deprecated && <Badge color="yellow">Deprecated</Badge>}
            {v.yanked && <Badge color="red">Yanked</Badge>}
            <VersionAdvisoryMarker advisoryIds={v.advisoryIds} advisories={listing.advisories} />
            <span className="text-xs text-fg-subtle">{formatDay(v.publishedAt)}</span>
            <span className="text-xs"><VulnCounts critical={v.vulnCritical} high={v.vulnHigh} /></span>
          </div>
          {v.deprecated && v.deprecationMessage && <p className="text-sm text-warning-strong">{v.deprecationMessage}</p>}
          {/* Changelog is publisher text: rendered as text, never markup. */}
          {v.changelog && <p className="whitespace-pre-line text-sm text-fg-muted">{v.changelog}</p>}
        </li>
      ))}
    </ol>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-1 py-2 sm:grid-cols-[12rem_1fr]">
      <dt className="text-sm text-fg-subtle">{label}</dt>
      <dd className="text-sm text-fg">{children}</dd>
    </div>
  );
}

function CodeList({ items, empty }: { items: string[]; empty: string }) {
  if (items.length === 0) return <span className="text-fg-subtle">{empty}</span>;
  return (
    <ul className="flex flex-wrap gap-1.5">
      {items.map((i) => <li key={i}><code className="rounded bg-surface-muted px-1.5 py-0.5 text-xs">{i}</code></li>)}
    </ul>
  );
}

export function ConfigurationPanel({ listing }: { listing: ListingDetail }) {
  const c = listing.configuration;
  return (
    <div className="space-y-6">
      <section aria-labelledby="cfg-secrets">
        <h3 id="cfg-secrets" className="mb-2 text-sm font-semibold text-fg">Secrets</h3>
        {c.secrets.length === 0 ? <Empty>This plugin needs no secrets.</Empty> : (
          <ul className="space-y-2">
            {c.secrets.map((s) => (
              <li key={s.name} className="text-sm">
                <code className="rounded bg-surface-muted px-1.5 py-0.5 text-xs">{s.name}</code>{' '}
                <Badge color={s.required ? 'red' : 'gray'}>{s.required ? 'Required' : 'Optional'}</Badge>
                {s.description && <p className="mt-0.5 text-fg-muted">{s.description}</p>}
              </li>
            ))}
          </ul>
        )}
      </section>
      <dl className="divide-y divide-default">
        <Row label="Plugin type">{c.pluginType}</Row>
        <Row label="Compute size">{c.computeType}</Row>
        <Row label="Required metadata"><CodeList items={c.requiredMetadata} empty="None" /></Row>
        <Row label="Required variables"><CodeList items={c.requiredVars} empty="None" /></Row>
        <Row label="Output directory">{c.primaryOutputDirectory ? <code className="text-xs">{c.primaryOutputDirectory}</code> : <span className="text-fg-subtle">None</span>}</Row>
        <Row label="Network egress"><CodeList items={c.networkEgress} empty="None declared" /></Row>
      </dl>
    </div>
  );
}

export function SupplyChainPanel({ listing }: { listing: ListingDetail }) {
  const s = listing.supplyChain;
  const sbom = safeExternalUrl(s.sbomUrl);
  return (
    <div className="space-y-6">
      <dl className="divide-y divide-default">
        <Row label="Signature">
          {s.signed
            ? <span className="inline-flex items-center gap-1 text-success-strong"><CheckCircle2 className="h-4 w-4" aria-hidden="true" /> Signed</span>
            : <span className="inline-flex items-center gap-1 text-danger-strong"><XCircle className="h-4 w-4" aria-hidden="true" /> Not signed</span>}
        </Row>
        <Row label="Image digest">{s.digest ? <code className="break-all text-xs">{s.digest}</code> : <span className="text-fg-subtle">—</span>}</Row>
        <Row label="Image source">{s.imageSource === 'uploaded' ? 'Uploaded image' : s.imageSource === 'built' ? 'Built from source by the platform' : (s.imageSource ?? '—')}</Row>
        <Row label="Vulnerabilities">
          <VulnCounts critical={s.vulnCritical} high={s.vulnHigh} />
          {s.scannedAt && <span className="ml-2 text-xs text-fg-subtle">scanned {formatDay(s.scannedAt)}</span>}
        </Row>
        <Row label="SBOM">
          {sbom
            ? <a href={sbom} className="action-link inline-flex items-center gap-1" rel="nofollow noopener noreferrer"><Download className="h-4 w-4" aria-hidden="true" /> Download SBOM</a>
            : <span className="text-fg-subtle">Not available</span>}
        </Row>
      </dl>
      {/* Each published version's own signed SBOM (SPDX JSON) — the one above is
          the latest version's; auditing a pinned older version needs its own. */}
      {listing.versions.some((v) => !v.yanked) && (
        <section aria-labelledby="sc-sboms">
          <h3 id="sc-sboms" className="mb-2 text-sm font-semibold text-fg">SBOM by version</h3>
          <ul className="space-y-1 text-sm">
            {listing.versions.filter((v) => !v.yanked).map((v) => (
              <li key={v.version} className="flex items-center gap-3">
                <span className="w-24 font-mono text-xs">v{v.version}</span>
                <a
                  href={versionSbomPath(listing.publisher.handle, listing.name, v.version)}
                  download={`${listing.name}-${v.version}.spdx.json`}
                  className="action-link inline-flex items-center gap-1"
                  rel="nofollow"
                  aria-label={`Download the SBOM for version ${v.version}`}
                >
                  <Download className="h-4 w-4" aria-hidden="true" /> SBOM
                </a>
              </li>
            ))}
          </ul>
        </section>
      )}
      {listing.advisories.length > 0 && (
        <section aria-labelledby="sc-advisories">
          <h3 id="sc-advisories" className="mb-2 text-sm font-semibold text-fg">Security advisories</h3>
          <AdvisoryList listing={listing} />
        </section>
      )}
    </div>
  );
}

export function AdvisoryList({ listing }: { listing: ListingDetail }) {
  return (
    <ul className="space-y-2">
      {listing.advisories.map((a) => (
        <li key={a.id} className="text-sm">
          <span className="font-mono text-xs">{a.id}</span>{' '}
          <Badge color={/critical|high/i.test(a.severity) ? 'red' : 'yellow'}>{a.severity}</Badge>{' '}
          {a.summary} <span className="text-fg-muted">— affects {a.affectedRange}{a.fixedVersion ? `, fixed in ${a.fixedVersion}` : ', no fix yet'}</span>
        </li>
      ))}
    </ul>
  );
}

const BUCKETS: RatingBucket[] = ['5', '4', '3', '2', '1'];

/**
 * The Reviews tab: the SSR summary (score, recent-versions rating, distribution)
 * and the review list + write surface, which load in the browser.
 */
export function ReviewsPanel({ listing, initialReviews }: { listing: ListingDetail; initialReviews?: ReviewPage | null }) {
  const dist = listing.ratingDistribution;
  const total = dist ? BUCKETS.reduce((n, b) => n + (dist[b] ?? 0), 0) : 0;
  return (
    <div className="space-y-6">
      <div className="max-w-md space-y-2">
        {listing.rating && listing.rating.count > 0 ? (
          <p className="text-sm text-fg">
            <span className="text-2xl font-semibold">{listing.rating.score.toFixed(1)}</span> out of 5 · {listing.rating.count} ratings
          </p>
        ) : (
          <p className="text-sm text-fg-muted">No ratings yet.</p>
        )}
        {listing.recentRating != null && (
          <p className="text-xs text-fg-muted" data-testid="recent-rating">Recent versions: {listing.recentRating.toFixed(1)}</p>
        )}
        {dist && total > 0 && (
          <ul className="space-y-1" aria-label="Rating distribution">
            {BUCKETS.map((b) => {
              const n = dist[b] ?? 0;
              const pct = Math.round((n / total) * 100);
              return (
                <li key={b} className="flex items-center gap-2 text-xs text-fg-muted">
                  <span className="w-8">{b}★</span>
                  <span className="h-2 flex-1 overflow-hidden rounded-full bg-surface-muted" aria-hidden="true">
                    <span className="block h-full rounded-full bg-warning" style={{ width: `${pct}%` }} />
                  </span>
                  <span className="w-12 text-right tabular-nums">{n}<span className="sr-only"> ratings with {b} stars</span></span>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      <ReviewsSection listing={listing} initial={initialReviews} />
    </div>
  );
}
