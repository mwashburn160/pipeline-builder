// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Catalog metadata on requests (docs/plugin-publishing.md):
 * a version's EFFECTIVE metadata (what upload detected and the user accepted
 * or edited, with provenance), the listing's live values, the changed-fields
 * offer a new version triggers, and applying an accepted set to a listing.
 */

import {
  METADATA_SOURCES,
  PLUGIN_CATALOG_FIELDS,
  type MetadataSource,
  type PluginCatalogEdits,
  type PluginCatalogField,
} from '@pipeline-builder/api-core';
import { renderUntrustedMarkdown } from '@pipeline-builder/api-server/lib/markdown.js';
import type { PluginIcon, PluginListing, PluginListingInsert } from '@pipeline-builder/pipeline-data';

import { isLinkField, sameValue } from './policy.js';
import type { PluginRow } from './store.js';

/** The fields a LISTING stores (displayName, documentationUrl and changelog are per version). */
export const LISTING_FIELDS: readonly PluginCatalogField[] = [
  'summary', 'description', 'category', 'keywords', 'license', 'homepageUrl', 'sourceUrl', 'icon', 'readme',
];

/** An accepted metadata set with its provenance, as a request's `payload.metadata` carries it. */
export interface RequestMetadata {
  values: Partial<Record<PluginCatalogField, unknown>>;
  sources: Partial<Record<PluginCatalogField, MetadataSource>>;
}

/** One field of a version's effective metadata. */
export function pluginFieldValue(p: PluginRow, field: PluginCatalogField): unknown {
  switch (field) {
    case 'readme': return p.readmeMd ?? null;
    case 'keywords': return p.keywords ?? [];
    case 'category': return p.category ?? null;
    default: return (p as unknown as Record<string, unknown>)[field] ?? null;
  }
}

/** A listing's live value for a listing field (the README as its rendered HTML). */
export function listingFieldValue(l: PluginListing, field: PluginCatalogField): unknown {
  switch (field) {
    case 'readme': return l.readmeHtml ?? null;
    case 'keywords': return l.keywords ?? [];
    default: return (l as unknown as Record<string, unknown>)[field] ?? null;
  }
}

/** The version's effective metadata: every descriptive field with the source upload recorded. */
export function effectiveMetadata(p: PluginRow): RequestMetadata {
  const recorded = (p.metadataSources ?? {}) as Partial<Record<PluginCatalogField, MetadataSource>>;
  const values: RequestMetadata['values'] = {};
  const sources: RequestMetadata['sources'] = {};
  for (const field of PLUGIN_CATALOG_FIELDS) {
    const value = pluginFieldValue(p, field);
    values[field] = value;
    if (recorded[field]) sources[field] = recorded[field];
  }
  return { values, sources };
}

/**
 * Apply the publisher's edits (the accept-or-edit form) over the version's
 * effective metadata. An edit that differs from the detected value is
 * provenance `user`; an edit equal to it keeps the detected source.
 */
export function applyEdits(base: RequestMetadata, edits: PluginCatalogEdits): RequestMetadata {
  const values = { ...base.values };
  const sources = { ...base.sources };
  for (const [field, value] of Object.entries(edits) as Array<[PluginCatalogField, unknown]>) {
    if (value === undefined) continue;
    if (!sameValue(value, base.values[field])) sources[field] = 'user';
    values[field] = value;
  }
  return { values, sources };
}

/** Whether a field's detected value (the plugin's) differs from the listing's live one. */
function listingDiffers(p: PluginRow, l: PluginListing, field: PluginCatalogField): boolean {
  // The listing keeps the README only as HTML, so compare rendered forms.
  if (field === 'readme') return !sameValue(p.readmeHtml ?? null, l.readmeHtml ?? null);
  return !sameValue(pluginFieldValue(p, field), listingFieldValue(l, field));
}

/**
 * The changed-fields-only `listing_update` offer a new version brings (
 * step 4): each listing field whose detected value differs from the live
 * listing, with both values. Nothing flows to the listing unless the publisher
 * submits it.
 */
export function listingUpdateOffer(p: PluginRow, l: PluginListing): Array<{ field: PluginCatalogField; value: unknown; current: unknown; source: MetadataSource | null }> {
  const recorded = (p.metadataSources ?? {}) as Partial<Record<PluginCatalogField, MetadataSource>>;
  return LISTING_FIELDS.filter((f) => listingDiffers(p, l, f)).map((field) => ({
    field,
    value: pluginFieldValue(p, field),
    current: listingFieldValue(l, field),
    source: recorded[field] ?? null,
  }));
}

/** Parse an optional `sources` map from a request body (unknown fields/sources dropped). */
export function parseSources(raw: unknown, fields: readonly string[]): RequestMetadata['sources'] {
  const out: RequestMetadata['sources'] = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (fields.includes(k) && typeof v === 'string' && (METADATA_SOURCES as readonly string[]).includes(v)) {
      out[k as PluginCatalogField] = v as MetadataSource;
    }
  }
  return out;
}

/** The listing columns an accepted metadata set writes (only the listing fields present in `values`). */
export function listingColumns(values: RequestMetadata['values']): Partial<PluginListingInsert> {
  const has = (f: PluginCatalogField) => Object.prototype.hasOwnProperty.call(values, f);
  const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null);
  const out: Partial<PluginListingInsert> = {};
  if (has('summary')) out.summary = str(values.summary)?.slice(0, 300) ?? null;
  if (has('description')) out.description = str(values.description);
  if (has('category')) out.category = str(values.category) ?? 'unknown';
  if (has('keywords')) out.keywords = Array.isArray(values.keywords) ? (values.keywords as unknown[]).map(String) : [];
  if (has('license')) out.license = str(values.license);
  if (has('homepageUrl')) out.homepageUrl = str(values.homepageUrl);
  if (has('sourceUrl')) out.sourceUrl = str(values.sourceUrl);
  if (has('icon')) out.icon = values.icon && typeof values.icon === 'object' ? values.icon as PluginIcon : null;
  if (has('readme')) {
    const md = str(values.readme);
    out.readmeHtml = md !== null ? renderUntrustedMarkdown(md) : null;
  }
  return out;
}

/**
 * One review row for a catalog field: the proposed value next to the live one
 * (`hasListing` false for a new listing), with its provenance. A user-edited
 * link that changes is highlighted — the field a reviewer must look at.
 */
export function metadataRow(field: string, value: unknown, previous: unknown, source: string | null, hasListing: boolean) {
  const userEdited = source === 'user';
  const changed = hasListing ? !sameValue(value, previous) : value !== null;
  return { field, value, previous, source, changed, userEdited, isLink: isLinkField(field), highlight: userEdited && isLinkField(field) && changed };
}
