// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Catalog metadata → plugin columns (docs/plugin-publishing.md).
 *
 * Detection, accept-or-edit and edit-payload parsing are pure and shared with
 * the CLI from api-core (`detectCatalogMetadata`, `resolveCatalogMetadata`,
 * `parseCatalogEdits`). Only the storage mapping lives here, because it renders
 * the README with the server's sanitizer.
 */

import type { ResolvedCatalog } from '@pipeline-builder/api-core';
import { renderUntrustedMarkdown } from '@pipeline-builder/api-server/lib/markdown.js';
import type { PluginIcon } from '@pipeline-builder/pipeline-data';

import type { PluginCatalogDocFields } from './plugin-helpers.js';

/** The columns a resolved catalog is stored as. */
export interface CatalogColumns extends PluginCatalogDocFields {
  description: string | null;
  category: string;
  keywords: string[];
}

/**
 * Map resolved catalog values onto plugin columns. The README is rendered here,
 * ONCE, to sanitized HTML (the only form any read path serves).
 */
export function catalogColumns(resolved: ResolvedCatalog): CatalogColumns {
  const v = resolved.values;
  const str = (x: unknown): string | null => (typeof x === 'string' && x !== '' ? x : null);
  const readmeMd = str(v.readme);
  return {
    description: str(v.description),
    category: str(v.category) ?? 'unknown',
    keywords: Array.isArray(v.keywords) ? (v.keywords as string[]) : [],
    summary: str(v.summary),
    displayName: str(v.displayName),
    readmeMd,
    readmeHtml: readmeMd !== null ? renderUntrustedMarkdown(readmeMd) : null,
    license: str(v.license),
    changelog: str(v.changelog),
    homepageUrl: str(v.homepageUrl),
    sourceUrl: str(v.sourceUrl),
    documentationUrl: str(v.documentationUrl),
    icon: (v.icon && typeof v.icon === 'object' ? v.icon as PluginIcon : null),
    metadataSources: resolved.sources,
  };
}
