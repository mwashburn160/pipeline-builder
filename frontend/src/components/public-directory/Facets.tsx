// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Facets and sorts as plain links: each option is the URL of the query with
 * that value toggled, so filtering works without JavaScript, is shareable, and
 * is reachable with Tab/Enter.
 */
import Link from 'next/link';
import { Check } from 'lucide-react';
import { CATEGORY_DISPLAY_NAMES, PLUGIN_CATEGORIES, isPluginCategory } from '@/lib/plugin-categories';
import { directoryHref, withParam, type DirectoryQuery } from '@/lib/public-directory/query';
import {
  SEARCH_SORTS, SORT_LABELS, TRUST_TIERS, TRUST_TIER_LABELS,
  type SearchFacets, type SearchSort,
} from '@/lib/public-directory/types';
import { categoryGlyph } from './PluginIcon';

type FacetKey = 'category' | 'tier' | 'license' | 'computeType' | 'needsSecrets' | 'minRating';

interface Option { value: string; label: string; count?: number; glyphFor?: string }

function FacetGroup({ title, facet, options, query, hrefFor }: {
  title: string;
  facet: FacetKey;
  options: Option[];
  query: DirectoryQuery;
  hrefFor: (q: DirectoryQuery) => string;
}) {
  if (options.length === 0) return null;
  const active = query[facet];
  return (
    <div>
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-fg-subtle">{title}</h3>
      <ul className="space-y-0.5">
        {options.map((o) => {
          const selected = active === o.value;
          const href = hrefFor(withParam(query, facet, selected ? undefined : (o.value as never)));
          const Glyph = o.glyphFor ? categoryGlyph(o.glyphFor) : null;
          return (
            <li key={o.value}>
              <Link
                href={href}
                scroll={false}
                aria-current={selected ? 'true' : undefined}
                className={`flex items-center gap-2 rounded-md px-2 py-1 text-sm transition-colors hover:bg-surface-muted ${selected ? 'font-medium text-brand' : 'text-fg-muted'}`}
              >
                {Glyph && <Glyph className="h-4 w-4 shrink-0" aria-hidden="true" />}
                <span className="min-w-0 flex-1 truncate">{o.label}</span>
                {selected && <Check className="h-3.5 w-3.5" aria-hidden="true" />}
                {selected && <span className="sr-only">(selected, activate to clear)</span>}
                {o.count !== undefined && <span className="text-xs tabular-nums text-fg-subtle">{o.count}</span>}
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

const byCount = (rec: Record<string, number> | undefined): Option[] =>
  Object.entries(rec ?? {})
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([value, count]) => ({ value, label: value, count }));

export function FacetPanel({ facets, query, showRating, hrefFor = directoryHref, hideCategory = false }: {
  facets: SearchFacets | null;
  query: DirectoryQuery;
  /** Minimum-rating filter — only offered once listings actually carry ratings. */
  showRating: boolean;
  hrefFor?: (q: DirectoryQuery) => string;
  hideCategory?: boolean;
}) {
  const categoryOptions: Option[] = PLUGIN_CATEGORIES
    .map((id) => ({ value: id, label: CATEGORY_DISPLAY_NAMES[id], count: facets?.category?.[id] ?? 0, glyphFor: id }))
    .filter((o) => o.count > 0 || query.category === o.value);
  // Categories the API knows but this build doesn't (forward-compatible).
  for (const [id, count] of Object.entries(facets?.category ?? {})) {
    if (!isPluginCategory(id) && count > 0) categoryOptions.push({ value: id, label: id, count, glyphFor: id });
  }
  const tierOptions: Option[] = TRUST_TIERS
    .map((t) => ({ value: t, label: TRUST_TIER_LABELS[t], count: facets?.tier?.[t] ?? 0 }))
    .filter((o) => o.count > 0 || query.tier === o.value);
  const secretOptions: Option[] = [
    { value: 'false', label: 'No secrets needed', count: facets?.needsSecrets?.false ?? 0 },
    { value: 'true', label: 'Needs secrets', count: facets?.needsSecrets?.true ?? 0 },
  ].filter((o) => o.count > 0 || query.needsSecrets === o.value);
  const ratingOptions: Option[] = showRating
    ? ['4', '3'].map((v) => ({ value: v, label: `${v}★ and up` }))
    : [];

  return (
    <nav aria-label="Filters" className="space-y-5">
      {!hideCategory && <FacetGroup title="Category" facet="category" options={categoryOptions} query={query} hrefFor={hrefFor} />}
      <FacetGroup title="Trust tier" facet="tier" options={tierOptions} query={query} hrefFor={hrefFor} />
      <FacetGroup title="Secrets" facet="needsSecrets" options={secretOptions} query={query} hrefFor={hrefFor} />
      <FacetGroup title="License" facet="license" options={byCount(facets?.license)} query={query} hrefFor={hrefFor} />
      <FacetGroup title="Compute size" facet="computeType" options={byCount(facets?.computeType)} query={query} hrefFor={hrefFor} />
      <FacetGroup title="Rating" facet="minRating" options={ratingOptions} query={query} hrefFor={hrefFor} />
    </nav>
  );
}

export function SortBar({ query, hrefFor = directoryHref }: { query: DirectoryQuery; hrefFor?: (q: DirectoryQuery) => string }) {
  // Relevance only means something when there is a text query.
  const current: SearchSort = query.sort ?? (query.q ? 'relevance' : 'name');
  const sorts = SEARCH_SORTS.filter((s) => s !== 'relevance' || query.q);
  return (
    <nav aria-label="Sort" className="flex flex-wrap items-center gap-1 text-sm">
      <span className="mr-1 text-fg-subtle">Sort:</span>
      {sorts.map((s) => (
        <Link
          key={s}
          href={hrefFor(withParam(query, 'sort', s))}
          scroll={false}
          aria-current={current === s ? 'true' : undefined}
          className={`rounded-md px-2 py-1 transition-colors hover:bg-surface-muted ${current === s ? 'bg-surface-muted font-medium text-fg' : 'text-fg-muted'}`}
        >
          {SORT_LABELS[s]}
        </Link>
      ))}
    </nav>
  );
}
