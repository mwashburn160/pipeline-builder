// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createLogger, errorMessage } from '@pipeline-builder/api-core';
import {
  buildPluginConditions, pluginResolutionOrderBy, schema, withTenantTx, withViewerContext, type PluginFilter,
} from '@pipeline-builder/pipeline-data';
import { and, asc, isNull, notInArray } from 'drizzle-orm';

import { rankSimilarPlugins, type SimilarPlugin, type SimilarPluginCandidate } from '../helpers/similar-plugins.js';

const logger = createLogger('similar-plugin-lookup');

/**
 * Upper bound on catalog rows pulled for ranking. The catalog is a few hundred
 * plugin versions; this caps the worst case without a text-search index.
 */
const CANDIDATE_LIMIT = 1000;

/**
 * Health score (W7) per plugin row id, for rows published to a listing (the
 * listed version's `source_plugin_id`). Loaded lazily so this module doesn't
 * pull the ecosystem store in; overridable in tests.
 */
let healthLookup: (pluginIds: string[]) => Promise<Map<string, number>> = async (pluginIds) => {
  const [{ versions }, { listingStats }] = await Promise.all([
    import('./ecosystem/store.js'),
    import('./ecosystem/reviews-store.js'),
  ]);
  const listed = await versions.bySourcePlugins(pluginIds);
  const stats = await listingStats.byListings([...new Set(listed.map((v) => v.listingId))]);
  const byListing = new Map(stats.filter((s) => s.healthScore !== null).map((s) => [s.listingId, s.healthScore as number]));
  const out = new Map<string, number>();
  for (const v of listed) {
    const h = byListing.get(v.listingId);
    if (v.sourcePluginId && h !== undefined) out.set(v.sourcePluginId, h);
  }
  return out;
};

/** Test hook: replace the health lookup. */
export function setSimilarPluginHealthLookupForTests(fn: typeof healthLookup): void {
  healthLookup = fn;
}

/**
 * The plugins in the caller's visible catalog most similar to `prompt` — the
 * AI generator's "similar plugins already exist" hint (plugin-ecosystem W6).
 *
 * Visibility is the shared plugin read ladder (`buildPluginConditions` with the
 * request's viewer stamped, own org + parent + system catalog) inside
 * `withTenantTx`: the `plugins` table is FORCE RLS, so a bare select would see
 * only system rows. Deleted, deprecated and yanked versions are never offered.
 * Rows are ordered by name then the lookup resolution order, so the ranker's
 * first-row-per-name is the version `/plugins/lookup` would resolve.
 *
 * A HINT, not a gate: any failure is logged and yields `[]` so generation
 * proceeds without it.
 */
export async function findSimilarPlugins(prompt: string, orgId: string, parentOrgId?: string): Promise<SimilarPlugin[]> {
  try {
    const rows = await withTenantTx(async (tx) => tx
      .select({
        id: schema.plugin.id,
        name: schema.plugin.name,
        version: schema.plugin.version,
        category: schema.plugin.category,
        summary: schema.plugin.summary,
        description: schema.plugin.description,
        keywords: schema.plugin.keywords,
      })
      .from(schema.plugin)
      .where(and(
        ...buildPluginConditions(withViewerContext<PluginFilter>({}), orgId, parentOrgId),
        isNull(schema.plugin.deletedAt),
        isNull(schema.plugin.deprecatedAt),
        isNull(schema.plugin.yankedAt),
        notInArray(schema.plugin.lifecycle, ['deprecated', 'yanked']),
      ))
      .orderBy(asc(schema.plugin.name), ...pluginResolutionOrderBy(orgId, parentOrgId))
      .limit(CANDIDATE_LIMIT)) as SimilarPluginCandidate[];
    // Health only breaks ties; without it the ranking stands.
    const health = await healthLookup(rows.map((r) => r.id)).catch((err) => {
      logger.warn('Similar-plugin health lookup failed; ranking without it', { orgId, error: errorMessage(err) });
      return new Map<string, number>();
    });
    return rankSimilarPlugins(prompt, rows.map((r) => ({ ...r, healthScore: health.get(r.id) ?? null })));
  } catch (err) {
    logger.warn('Similar-plugin lookup failed; generating without catalog context', { orgId, error: errorMessage(err) });
    return [];
  }
}
