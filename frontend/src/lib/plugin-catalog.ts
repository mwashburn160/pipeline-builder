// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Client-side helpers for a plugin's descriptive CATALOG fields (plugin-ecosystem
 * §3.1a): labels, editor kinds, value <-> form-text conversion and LIGHT checks.
 *
 * The server's validator (api-core `validation/plugin-catalog-metadata.ts`) is
 * authoritative — these checks only catch the obvious mistakes (length caps,
 * non-https links) before a round trip, and the server's 400 message is what the
 * user ultimately sees. The limits mirror that file; keep them in step.
 */

import type { PluginCatalogEdits, PluginCatalogField, PluginIcon, PluginMetadataSource } from '@/types';
import { PLUGIN_CATEGORIES } from '@/lib/plugin-categories';

export const PLUGIN_SUMMARY_MAX = 160;
export const PLUGIN_DESCRIPTION_MAX = 2000;
export const PLUGIN_DISPLAY_NAME_MAX = 100;
export const PLUGIN_KEYWORDS_MAX = 10;
export const PLUGIN_KEYWORD_MAX_LENGTH = 32;
export const PLUGIN_README_MAX_BYTES = 64 * 1024;
export const PLUGIN_CHANGELOG_MAX_BYTES = 32 * 1024;
export const PLUGIN_URL_MAX = 2048;
const ICON_KEY_PATTERN = /^[a-z0-9-]+$/;

/** Human label per catalog field. */
export const CATALOG_FIELD_LABELS: Record<PluginCatalogField, string> = {
  displayName: 'Display name',
  summary: 'Summary',
  description: 'Description',
  category: 'Category',
  keywords: 'Keywords',
  license: 'License',
  homepageUrl: 'Homepage URL',
  sourceUrl: 'Source URL',
  documentationUrl: 'Documentation URL',
  icon: 'Icon',
  changelog: 'Changelog',
  readme: 'README',
};

/** Which inline editor a field uses. */
export type CatalogEditorKind = 'text' | 'textarea' | 'select' | 'keywords';

export const CATALOG_FIELD_EDITOR: Record<PluginCatalogField, CatalogEditorKind> = {
  displayName: 'text',
  summary: 'text',
  description: 'textarea',
  category: 'select',
  keywords: 'keywords',
  license: 'text',
  homepageUrl: 'text',
  sourceUrl: 'text',
  documentationUrl: 'text',
  icon: 'text',
  changelog: 'textarea',
  readme: 'textarea',
};

/** Short guidance under an editor. */
export const CATALOG_FIELD_HINTS: Partial<Record<PluginCatalogField, string>> = {
  summary: `One line for the catalog card, up to ${PLUGIN_SUMMARY_MAX} characters.`,
  keywords: `Comma-separated, up to ${PLUGIN_KEYWORDS_MAX} keywords of ${PLUGIN_KEYWORD_MAX_LENGTH} characters each.`,
  license: 'An SPDX identifier, e.g. Apache-2.0 or MIT.',
  homepageUrl: 'An https:// link.',
  sourceUrl: 'An https:// link.',
  documentationUrl: 'An https:// link.',
  icon: 'A curated icon key (lowercase letters, digits and dashes).',
};

/** Badge label per detected source. */
export const CATALOG_SOURCE_LABELS: Record<PluginMetadataSource, string> = {
  spec: 'Spec',
  readme: 'README',
  dockerfile: 'Dockerfile',
  derived: 'Generated',
  user: 'Edited',
};

export { PLUGIN_CATEGORIES };

/** A stored/detected catalog value as the text its editor shows. */
export function catalogValueToText(field: PluginCatalogField, value: unknown): string {
  if (value == null) return '';
  if (field === 'keywords' && Array.isArray(value)) return value.join(', ');
  if (field === 'icon' && typeof value === 'object') return (value as PluginIcon).key ?? '';
  return typeof value === 'string' ? value : String(value);
}

const utf8Bytes = (v: string): number => (typeof TextEncoder !== 'undefined'
  ? new TextEncoder().encode(v).length
  : new Blob([v]).size);

function urlProblem(raw: string): string | null {
  if (raw.length > PLUGIN_URL_MAX) return `must be at most ${PLUGIN_URL_MAX} characters`;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return 'must be an absolute URL';
  }
  if (url.protocol !== 'https:') return 'must use https';
  if (url.username || url.password) return 'must not embed credentials';
  return null;
}

/**
 * Parse an editor's text into the value sent for `field` — `null` for blank
 * (clears the field) — or the reason it is refused client-side. `prevIcon`
 * keeps an existing icon's badge when only the key is edited.
 */
export function parseCatalogText(
  field: PluginCatalogField,
  text: string,
  prevIcon?: PluginIcon | null,
): { ok: true; value: PluginCatalogEdits[PluginCatalogField] } | { ok: false; error: string } {
  const trimmed = text.trim();
  if (!trimmed) return { ok: true, value: null };
  const max = (n: number) => (trimmed.length > n ? `must be at most ${n} characters` : null);
  let problem: string | null = null;
  switch (field) {
    case 'displayName': problem = max(PLUGIN_DISPLAY_NAME_MAX); break;
    case 'summary': problem = max(PLUGIN_SUMMARY_MAX); break;
    case 'description': problem = max(PLUGIN_DESCRIPTION_MAX); break;
    case 'category':
      if (!(PLUGIN_CATEGORIES as readonly string[]).includes(trimmed)) problem = 'must be one of the listed categories';
      break;
    case 'keywords': {
      const keywords = trimmed.split(',').map((k) => k.trim()).filter(Boolean);
      if (keywords.length > PLUGIN_KEYWORDS_MAX) return { ok: false, error: `at most ${PLUGIN_KEYWORDS_MAX} keywords` };
      if (keywords.some((k) => k.length > PLUGIN_KEYWORD_MAX_LENGTH)) {
        return { ok: false, error: `each keyword must be at most ${PLUGIN_KEYWORD_MAX_LENGTH} characters` };
      }
      return { ok: true, value: keywords };
    }
    case 'homepageUrl':
    case 'sourceUrl':
    case 'documentationUrl':
      problem = urlProblem(trimmed);
      break;
    case 'icon':
      if (trimmed.length > 64 || !ICON_KEY_PATTERN.test(trimmed)) problem = 'must be lowercase letters, digits and dashes';
      else return { ok: true, value: prevIcon?.badge ? { key: trimmed, badge: prevIcon.badge } : trimmed };
      break;
    case 'changelog':
      if (utf8Bytes(text) > PLUGIN_CHANGELOG_MAX_BYTES) problem = `must be at most ${PLUGIN_CHANGELOG_MAX_BYTES} bytes`;
      else return { ok: true, value: text };
      break;
    case 'readme':
      if (utf8Bytes(text) > PLUGIN_README_MAX_BYTES) problem = `must be at most ${PLUGIN_README_MAX_BYTES} bytes`;
      else return { ok: true, value: text };
      break;
    case 'license':
      break;
  }
  return problem ? { ok: false, error: problem } : { ok: true, value: trimmed };
}
