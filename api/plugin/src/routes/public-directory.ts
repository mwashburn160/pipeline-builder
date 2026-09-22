// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The anonymous public plugin directory API (plugin-ecosystem §6a).
 *
 * nginx maps `/api/public/*` → `/public/*` here, GET/HEAD only, with
 * `Authorization` and `Cookie` stripped — so nothing below ever sees who is
 * asking, and every response is safe for a shared CDN cache. Reads go through
 * the view-only `ecosystem_public_reader` pool (pipeline-data public-reader.ts),
 * which can see the `public_*` views and nothing else; the only app-db write is
 * the anonymous zero-result search log.
 *
 * Off (`PUBLIC_DIRECTORY_ENABLED=false`, or no reader password) → every route
 * answers 404, which the frontend renders as "directory not available".
 *
 * Rate limited per TRUSTED client IP (G12). Server-rendered directory pages call
 * this API from the frontend server, so they share its bucket — hence the
 * configurable, fairly generous default; the pages' CDN caching absorbs most of
 * that traffic.
 */

import { ErrorCode, sendBadRequest, sendError, sendSuccess } from '@pipeline-builder/api-core';
import { rateLimitByOrg, withRoute } from '@pipeline-builder/api-server';
import { Config } from '@pipeline-builder/pipeline-core';
import {
  db, getPublicListedVersion, getPublicListing, isPublicReaderConfigured, listPublicCategories,
  listPublicListingsForSitemap, listPublicReviews, normalizeQuery, schema, searchPublicListings,
  DIRECTORY_SORTS, DIRECTORY_TIERS, REVIEW_SORTS,
  type DirectorySearchParams, type DirectorySort, type DirectoryTrustTier, type ReviewSort,
} from '@pipeline-builder/pipeline-data';
import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';

import { attachmentDisposition } from '../helpers/content-disposition.js';
import { normalizeSearchQuery } from '../helpers/search-query.js';
import { fetchPublicImageSbom, ImageVerificationError, SbomBusyError } from '../helpers/supply-chain.js';

/** Publisher handle (same shape as the `public/<handle>` registry namespace). */
const HANDLE_RE = /^[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*$/;
/** Plugin name. */
const NAME_RE = /^[a-z0-9][a-z0-9._-]*$/;
/** Semver version (no build metadata). */
const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
/** Filter tokens — mirrors the frontend's query whitelist (lib/public-directory/query.ts). */
const TOKEN_RE = /^[A-Za-z0-9._+\-: ]+$/;
const MAX_SEGMENT = 128;

/** Search results change as listings change; keep the edge copy short. */
const SEARCH_CACHE = 'public, max-age=60, s-maxage=60, stale-while-revalidate=600';
const DETAIL_CACHE = 'public, max-age=120, s-maxage=120, stale-while-revalidate=600';
const CATEGORIES_CACHE = 'public, max-age=300, s-maxage=300, stale-while-revalidate=3600';
/** A published version's image (and so its SBOM) never changes; yanking removes the route. */
const SBOM_CACHE = 'public, max-age=3600, s-maxage=3600';

function flagOn(name: string, def: boolean): boolean {
  const v = (process.env[name] ?? '').trim().toLowerCase();
  if (v === '') return def;
  return v === 'true' || v === '1' || v === 'yes';
}

/** Whether the directory can serve right now (flag on AND the reader login is configured). */
export function isPublicDirectoryEnabled(): boolean {
  return flagOn('PUBLIC_DIRECTORY_ENABLED', true) && isPublicReaderConfigured();
}

function rateLimitPerMinute(): number {
  const n = Number.parseInt(process.env.PUBLIC_DIRECTORY_RATE_LIMIT_PER_MIN ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : 120;
}

const token = z.string().trim().min(1).max(MAX_SEGMENT).regex(TOKEN_RE);

const SearchQuerySchema = z.object({
  q: z.string().max(1000).optional(),
  category: z.string().regex(/^[a-z]+$/).max(50).optional(),
  tier: z.enum(DIRECTORY_TIERS as unknown as [DirectoryTrustTier, ...DirectoryTrustTier[]]).optional(),
  license: token.optional(),
  computeType: token.optional(),
  needsSecrets: z.enum(['true', 'false']).optional(),
  minRating: z.coerce.number().int().min(1).max(5).optional(),
  sort: z.enum(DIRECTORY_SORTS as unknown as [DirectorySort, ...DirectorySort[]]).optional(),
  cursor: z.string().max(512).regex(/^[A-Za-z0-9_\-=.]+$/).optional(),
  // Oversized limits are capped by the query layer rather than refused.
  limit: z.coerce.number().int().min(1).max(1000).optional(),
});

const ReviewQuerySchema = z.object({
  sort: z.enum(REVIEW_SORTS as unknown as [ReviewSort, ...ReviewSort[]]).optional(),
  rating: z.coerce.number().int().min(1).max(5).optional(),
  cursor: z.string().max(512).regex(/^[A-Za-z0-9_\-=.]+$/).optional(),
  limit: z.coerce.number().int().min(1).max(1000).optional(),
});

/** Reviews change with every vote and write; keep the edge copy short. */
const REVIEWS_CACHE = 'public, max-age=60, s-maxage=60, stale-while-revalidate=300';
/** The same page read fresh (the viewer's own change): never stored by any cache. */
const REVIEWS_FRESH_CACHE = 'private, no-store';

/** First value of a possibly-repeated query param (Express gives arrays for `?a=1&a=2`). */
function firstValues(query: Request['query']): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(query)) out[k] = Array.isArray(v) ? v[0] : v;
  return out;
}

/** Record a zero-result search (§6a "what people look for"). Best effort, never blocks the answer. */
function logSearchMiss(q: string, category: string | undefined): void {
  // Normalized at write, so the maintenance sweep can fold repeats into one counted row (E17).
  void db.insert(schema.ecosystemSearchMiss)
    .values({ query: normalizeSearchQuery(q), category: category ?? null })
    .catch(() => { /* analytics only */ });
}

function notFound(res: Response): void {
  sendError(res, 404, 'Not found', ErrorCode.NOT_FOUND);
}

/**
 * Validate a `:publisher/:name` pair. Returns null (after answering 404) when
 * either can't be a real listing — a malformed segment is "not listed", not a
 * 400, so the pages treat every bad URL the same.
 */
function listingParams(req: Request, res: Response): { publisher: string; name: string } | null {
  const publisher = String(req.params.publisher ?? '');
  const name = String(req.params.name ?? '');
  if (publisher.length > MAX_SEGMENT || name.length > MAX_SEGMENT || !HANDLE_RE.test(publisher) || !NAME_RE.test(name)) {
    notFound(res);
    return null;
  }
  return { publisher, name };
}

/** Routes under `/public`. No authentication by design. */
export function createPublicDirectoryRoutes(): Router {
  const router = Router();

  router.use((_req: Request, res: Response, next: NextFunction) => {
    if (!isPublicDirectoryEnabled()) return notFound(res);
    // Responses never depend on the caller; say so to every cache in front.
    res.setHeader('Vary', 'Accept-Encoding');
    next();
  });
  router.use(rateLimitByOrg({ name: 'public-directory', max: rateLimitPerMinute(), windowMs: 60_000 }));

  // GET /public/plugins — search / browse with facets.
  router.get('/plugins', withRoute(async ({ req, res, ctx }) => {
    const parsed = SearchQuerySchema.safeParse(firstValues(req.query));
    if (!parsed.success) return sendBadRequest(res, 'Invalid directory query', ErrorCode.VALIDATION_ERROR);
    const v = parsed.data;
    const params: DirectorySearchParams = {
      q: v.q,
      category: v.category,
      tier: v.tier,
      license: v.license,
      computeType: v.computeType,
      needsSecrets: v.needsSecrets === undefined ? undefined : v.needsSecrets === 'true',
      minRating: v.minRating,
      sort: v.sort,
      cursor: v.cursor,
      limit: v.limit,
    };
    const result = await searchPublicListings(params);

    const q = normalizeQuery(v.q);
    if (result.total === 0 && q && !v.cursor) logSearchMiss(q, v.category);

    ctx.log('COMPLETED', 'Public directory search', { total: result.total, hasQuery: q !== '' });
    res.setHeader('Cache-Control', SEARCH_CACHE);
    return sendSuccess(res, 200, result);
  }, { requireOrgId: false }));

  // GET /public/plugins/categories — every category with its count and top listings.
  router.get('/plugins/categories', withRoute(async ({ res }) => {
    const categories = await listPublicCategories();
    res.setHeader('Cache-Control', CATEGORIES_CACHE);
    return sendSuccess(res, 200, { categories });
  }, { requireOrgId: false }));

  // GET /public/plugins/sitemap — every listing's URL parts, in one call (pages/sitemap.xml.ts).
  router.get('/plugins/sitemap', withRoute(async ({ res }) => {
    const entries = await listPublicListingsForSitemap();
    res.setHeader('Cache-Control', CATEGORIES_CACHE);
    return sendSuccess(res, 200, { entries });
  }, { requireOrgId: false }));

  // GET /public/plugins/:publisher/:name/versions/:version/sbom — the signed SBOM of a listed version.
  router.get('/plugins/:publisher/:name/versions/:version/sbom', withRoute(async ({ req, res, ctx }) => {
    const p = listingParams(req, res);
    if (!p) return;
    const version = String(req.params.version ?? '');
    if (version.length > MAX_SEGMENT || !VERSION_RE.test(version)) return notFound(res);

    const image = await getPublicListedVersion(p.publisher, p.name, version);
    if (!image) return notFound(res);

    let sbom: Record<string, unknown>;
    try {
      sbom = await fetchPublicImageSbom(image.imageRepository, image.imageDigest, Config.get('registry'));
    } catch (err) {
      if (err instanceof SbomBusyError) {
        res.setHeader('Retry-After', '5');
        return sendError(res, 503, err.message, ErrorCode.SERVICE_UNAVAILABLE);
      }
      if (!(err instanceof ImageVerificationError)) throw err;
      ctx.log('WARN', 'Public SBOM failed verification', { ...p, version, error: err.message });
      return sendError(res, 409, 'This version has no verified SBOM', ErrorCode.IMAGE_VERIFICATION_FAILED);
    }

    res.setHeader('Cache-Control', SBOM_CACHE);
    res.setHeader('Content-Disposition', attachmentDisposition(`${p.publisher}-${p.name}-${version}.spdx.json`));
    res.status(200).type('application/spdx+json').send(JSON.stringify(sbom));
  }, { requireOrgId: false }));

  // GET /public/plugins/:publisher/:name/reviews — published reviews (§5): display names only.
  router.get('/plugins/:publisher/:name/reviews', withRoute(async ({ req, res }) => {
    const p = listingParams(req, res);
    if (!p) return;
    const parsed = ReviewQuerySchema.safeParse(firstValues(req.query));
    if (!parsed.success) return sendBadRequest(res, 'Invalid review query', ErrorCode.VALIDATION_ERROR);
    const page = await listPublicReviews(p.publisher, p.name, parsed.data);
    if (!page) return notFound(res);
    // A viewer re-reading right after their own write (`?fresh=1`), or any
    // credentialed request, must not get — or seed — the shared edge copy (E24).
    const fresh = firstValues(req.query).fresh === '1' || typeof req.headers.authorization === 'string';
    res.setHeader('Cache-Control', fresh ? REVIEWS_FRESH_CACHE : REVIEWS_CACHE);
    return sendSuccess(res, 200, page);
  }, { requireOrgId: false }));

  // GET /public/plugins/:publisher/:name — one listing's page data.
  router.get('/plugins/:publisher/:name', withRoute(async ({ req, res }) => {
    const p = listingParams(req, res);
    if (!p) return;
    const listing = await getPublicListing(p.publisher, p.name);
    if (!listing) return notFound(res);
    res.setHeader('Cache-Control', DETAIL_CACHE);
    return sendSuccess(res, 200, { listing });
  }, { requireOrgId: false }));

  return router;
}
