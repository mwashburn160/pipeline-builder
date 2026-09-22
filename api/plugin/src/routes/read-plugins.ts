// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import {
  asScanFlag, blockOnNewCritical, getParam, ErrorCode, isSystemOrgId, requirePermission, sendBadRequest, sendError, sendSuccess, sendPaginatedNested,
  parsePaginationParams, validateQuery, PluginFilterSchema, sendEntityNotFound, vulnBlockedMessage, vulnFlaggedWarning,
} from '@pipeline-builder/api-core';
import type { QuotaService, VulnFlaggedWarning } from '@pipeline-builder/api-core';
import { incCounter, withRoute, meterQuotaOnSuccess } from '@pipeline-builder/api-server';
import type { RequestContext } from '@pipeline-builder/api-server';
import { Config, CoreConstants, pluginImageRepository } from '@pipeline-builder/pipeline-core';
import { executeRows, isVersionRange, withTenantTx } from '@pipeline-builder/pipeline-data';
import type { PluginFilter } from '@pipeline-builder/pipeline-data';
import { sql } from 'drizzle-orm';
import type { Request, Response } from 'express';
import { Router } from 'express';
import { attachmentDisposition } from '../helpers/content-disposition.js';
import { pipelinePluginRefs } from '../helpers/pipeline-plugin-refs.js';
import { pluginRequiresImage, shapePlugin } from '../helpers/plugin-helpers.js';
import { fetchImageSbom, ImageVerificationError, verifyImageSignature } from '../helpers/supply-chain.js';
import { resolveListedLookup, shadowedListing, verifyListedImage } from '../services/ecosystem/lookup.js';
import { pluginService } from '../services/plugin-service.js';

/** The caller's parent-org id (org→team hierarchy), carried in the JWT; absent
 *  for root orgs. Centralizes the one cast the read handlers all need. */
function parentOrgIdOf(req: Request): string | undefined {
  return (req.user as { parentOrganizationId?: string } | undefined)?.parentOrganizationId;
}

/** A warning attached to a lookup answer (lifecycle, listings, advisories, rescan flags). */
export type LookupWarning =
  | { code: 'PLUGIN_DEPRECATED' | 'PLUGIN_YANKED' | 'PLUGIN_SHADOWS_LISTING' | 'PLUGIN_SECRETS_WITHHELD' | 'LISTING_UNMAINTAINED' | 'PLUGIN_ADVISORY'; message: string }
  | VulnFlaggedWarning;

/** The lifecycle warnings a resolved version carries (empty for a healthy one). */
export function lookupWarnings(plugin: {
  name: string;
  version: string;
  lifecycle?: string | null;
  yankedAt?: Date | string | null;
  yankReason?: string | null;
  deprecatedAt?: Date | string | null;
  deprecationMessage?: string | null;
  scanFlaggedAt?: Date | string | null;
  scanFlag?: unknown;
}): LookupWarning[] {
  const ref = `${plugin.name}@${plugin.version}`;
  const warnings: LookupWarning[] = [];
  if (plugin.yankedAt || plugin.lifecycle === 'yanked') {
    warnings.push({
      code: 'PLUGIN_YANKED',
      message: `Plugin ${ref} is yanked${plugin.yankReason ? `: ${plugin.yankReason}` : ''}. It resolves only because it is pinned exactly; move to a supported version.`,
    });
  }
  if (plugin.deprecatedAt || plugin.lifecycle === 'deprecated') {
    warnings.push({
      code: 'PLUGIN_DEPRECATED',
      message: `Plugin ${ref} is deprecated${plugin.deprecationMessage ? `: ${plugin.deprecationMessage}` : ''}.`,
    });
  }
  // A rescan flagged it (fixable Criticals over PLUGIN_VULN_MAX_CRITICAL); it
  // resolves only because block mode is off — say so, with the fixes.
  const flag = plugin.scanFlaggedAt ? asScanFlag(plugin.scanFlag) : null;
  if (flag) warnings.push(vulnFlaggedWarning(plugin.name, plugin.version, flag));
  return warnings;
}

/** Whether a lookup filter pins ONE version exactly (by id or an exact version). */
export function isPinnedFilter(filter: PluginFilter): boolean {
  return filter.id !== undefined || (filter.version !== undefined && !isVersionRange(filter.version));
}

/**
 * The filter a single-plugin RESOLUTION runs with: the name matches exactly
 * (`trivy` never resolves to `trivy-scan`), and a yanked version is excluded
 * unless the caller pinned it exactly — by id or by an exact version (ranges
 * already exclude yanked versions in the query builder).
 */
export function resolutionFilter(filter: PluginFilter, opts: { excludeScanFlagged?: boolean } = {}): PluginFilter {
  const pinned = isPinnedFilter(filter);
  return {
    ...filter,
    ...(filter.name !== undefined ? { nameMatch: 'exact' as const } : {}),
    ...(pinned ? {} : { excludeYanked: true }),
    ...(opts.excludeScanFlagged && !pinned ? { excludeScanFlagged: true } : {}),
  };
}

/** Lookup refusal reasons, as `plugin_lookup_refusals_total{reason}` reports them. */
const LOOKUP_REFUSAL_REASONS: Record<string, string> = { yanked: 'yank', blocked_listing: 'policy', vuln_flagged: 'vuln' };

/**
 * Count a refused lookup (synth resolving a plugin it may not use): a failed
 * signature, or a tier / yank / advisory / policy / install refusal. The
 * PluginLookupRefusalSpike alert watches the signature and tier reasons.
 */
export function recordLookupRefusal(reason: string): void {
  incCounter('plugin_lookup_refusals_total', { reason: LOOKUP_REFUSAL_REASONS[reason] ?? reason });
}

/**
 * Register the read routes.
 *
 * Expects auth + orgId + tenant scope (the shared `/plugins` chain) from the
 * parent mount. `plugins:read` is attached PER ROUTE here rather than at the
 * mount: the mount's gates are prefix layers that also run for every request
 * falling through to the later write mounts, which must not require `:read`.
 */
export function createReadPluginRoutes(
  quotaService: QuotaService,
): Router {
  const router: Router = Router();
  // apiCalls metering: once per 2xx, never for service principals.
  const meter = meterQuotaOnSuccess(quotaService, 'apiCalls');

  // GET /plugins/plugin-usage — counts pipelines (in caller's org) that
  // reference each plugin, keyed by the REFERENCE: the
  // bare `name` for an unqualified reference (the org's own plugin, or the
  // Official listing it falls back to) and `publisher/name` for a qualified
  // one. Used by the "Used by N pipelines" badges on the org's plugins and on
  // catalog listings. Returns { counts: { [key]: number } }; zero-usage keys
  // are absent. Counts the synth plugin too.
  //
  // Lives on the plugin service (not pipeline) because the consumer is the
  // plugins dashboard. The query reads the shared `pipeline` table via the
  // pipeline-data drizzle connection — both services share the same Postgres.
  router.get('/plugin-usage', requirePermission('plugins:read'), withRoute(async ({ res, ctx, orgId }) => {
    // Explicit per-org scoping (defense-in-depth) on top of `withTenantTx`'s
    // `app.org_id`, mirroring how the lookup and ai-generation services scope.
    // The route-context `orgId` is already lowercased to match stored org ids.
    const rows = await withTenantTx(async (tx) => executeRows<{ ref_key: string; cnt: string | number }>(tx, sql`
      SELECT CASE WHEN COALESCE(ref->>'publisher', '') = '' THEN ref->>'name'
                  ELSE (ref->>'publisher') || '/' || (ref->>'name') END AS ref_key,
             COUNT(DISTINCT p.id) AS cnt
        FROM pipelines p,
             ${pipelinePluginRefs()}
       WHERE p.is_active = true
         AND p.deleted_at IS NULL
         AND p.org_id = ${orgId}
         AND ref->>'name' IS NOT NULL
       GROUP BY 1
    `));
    const counts: Record<string, number> = {};
    for (const row of rows) {
      const n = typeof row.cnt === 'number' ? row.cnt : parseInt(String(row.cnt), 10);
      if (row.ref_key && Number.isFinite(n)) counts[row.ref_key] = n;
    }
    ctx.log('COMPLETED', 'Computed plugin usage', { distinct: Object.keys(counts).length });
    res.setHeader('Cache-Control', CoreConstants.CACHE_CONTROL_LIST);
    return sendSuccess(res, 200, { counts });
  }));

  // GET /plugins — paginated list
  router.get('/', meter, requirePermission('plugins:read'), withRoute(async ({ req, res, ctx, orgId }) => {
    const filter = validateQuery(req, PluginFilterSchema);
    if (!filter.ok) return sendBadRequest(res, filter.error);

    const { limit, offset, sortBy, sortOrder } = parsePaginationParams(
      req.query as Record<string, unknown>,
    );

    const includeTotal = req.query.includeTotal === 'true';
    const cursor = req.query.cursor as string | undefined;
    const fields = req.query.fields ? (req.query.fields as string).split(',') : undefined;

    // Org → team hierarchy: a team org also sees its parent's public plugins.
    // `parentOrganizationId` rides in the JWT (absent for root orgs), so this
    // is a no-op for non-team callers.
    const parentOrgId = parentOrgIdOf(req);

    const result = await pluginService.findPaginated(
      filter.value,
      orgId,
      { limit, offset, sortBy, sortOrder, includeTotal, cursor, fields },
      parentOrgId,
    );

    ctx.log('COMPLETED', 'Listed plugins', { count: result.data.length, ...(result.total !== undefined && { total: result.total }) });

    res.setHeader('Cache-Control', CoreConstants.CACHE_CONTROL_LIST);

    return sendPaginatedNested(res, 'plugins', result.data.map(r => shapePlugin(r)), {
      total: result.total, limit: result.limit, offset: result.offset, hasMore: result.hasMore, nextCursor: result.nextCursor,
    });
  }));

  // Shared single-plugin lookup. `/lookup` POST takes the filter from the
  // body; `/find` GET reads it from query string. Same `PluginFilterSchema`
  // whitelist as the listing endpoint so callers can't smuggle internal
  // fields (`deletedAt`, `orgId`) to peek at soft-deleted rows.
  //
  // Resolution order:
  //   - no `publisher`: the org's own plugin row, then (a team) its parent's
  //     shared row, then the Official listing through the org's install
  //     (explicit, or the implicit one). An own row that shadows an
  //     Official listing answers with a PLUGIN_SHADOWS_LISTING warning;
  //   - `publisher`: ONLY that publisher's listing, through an install.
  // A listed version answers with its `public/*` imageRepository, verified
  // with its signed tier annotation.
  const respondWithSinglePlugin = async (
    filter: PluginFilter,
    req: Request, res: Response, orgId: string,
    ctx: RequestContext,
    opts: { setCacheHeader: boolean },
  ) => {
    // Org → team hierarchy: a team org also sees its parent's public plugins
    // (mirrors the list path). No-op for root orgs (claim absent).
    const parentOrgId = parentOrgIdOf(req);
    const scope = { orgId, ...(parentOrgId ? { rootOrgId: parentOrgId } : {}) };
    const { publisher, ...rowFilter } = filter;
    const done = (plugin: Record<string, unknown>, warnings: LookupWarning[], id: unknown, name: unknown) => {
      ctx.log('COMPLETED', 'Plugin lookup', { id, name, ...(publisher ? { publisher } : {}), ...(warnings.length ? { warnings: warnings.map((w) => w.code) } : {}) });
      if (opts.setCacheHeader) res.setHeader('Cache-Control', CoreConstants.CACHE_CONTROL_LIST);
      return sendSuccess(res, 200, { plugin, warnings });
    };
    const verificationFailed = (err: unknown, id: unknown, name: unknown) => {
      if (!(err instanceof ImageVerificationError)) throw err;
      recordLookupRefusal('signature');
      ctx.log('WARN', 'Plugin image failed verification', { id, name, error: err.message });
      return sendError(res, 409, err.message, ErrorCode.IMAGE_VERIFICATION_FAILED);
    };

    if (!publisher) {
      // PLUGIN_BLOCK_ON_NEW_CRITICAL: a range / the default skips rescan-flagged
      // versions (the newest unflagged satisfying one wins); an exact pin to a
      // flagged version — or a range whose every version is flagged — is refused
      // 409 PLUGIN_VERSION_VULN_BLOCKED naming the fix (never a silent fallback
      // to a listing of the same name).
      const blockFlagged = blockOnNewCritical();
      let result = await pluginService.findFirst(resolutionFilter(rowFilter, { excludeScanFlagged: blockFlagged }), orgId, parentOrgId);
      if (!result && blockFlagged && !isPinnedFilter(rowFilter)) {
        const onlyFlagged = await pluginService.findFirst(resolutionFilter(rowFilter), orgId, parentOrgId);
        if (onlyFlagged?.scanFlaggedAt) result = onlyFlagged;
      }
      if (result && blockFlagged && result.scanFlaggedAt) {
        const flag = asScanFlag(result.scanFlag) ?? { critical: 0, high: 0, maxCritical: 0, findings: [] };
        recordLookupRefusal('vuln_flagged');
        ctx.log('WARN', 'Plugin lookup refused: rescan-flagged version', { id: result.id, name: result.name, version: result.version });
        return sendError(res, 409, vulnBlockedMessage(result.name, result.version, flag), ErrorCode.PLUGIN_VERSION_VULN_BLOCKED, {
          reason: 'vuln_flagged', version: result.version, critical: flag.critical, high: flag.high, findings: flag.findings,
        });
      }
      if (result) {
        const imageRepository = pluginImageRepository(result);
        // These are the endpoints synth resolves plugins through, and synth pins
        // CodeBuild to the returned `imageDigest` — so never hand out a digest whose
        // signature doesn't verify against the plugin-signing key (or a plugin that
        // needs an image but has no signed digest at all).
        if (pluginRequiresImage(result)) {
          try {
            await verifyImageSignature({ ...result, imageRepository }, Config.get('registry'));
          } catch (err) {
            return verificationFailed(err, result.id, result.name);
          }
        }
        // Deprecated / yanked-but-pinned versions still resolve, with a warning the
        // caller surfaces (synth prints it).
        const warnings = lookupWarnings(result);
        if (rowFilter.name && !isSystemOrgId(orgId)) {
          const listing = await shadowedListing(scope, result.name);
          if (listing) {
            warnings.push({
              code: 'PLUGIN_SHADOWS_LISTING',
              message: `Your organization's plugin ${result.name} shadows the Official listing ${listing.publisher}/${listing.name}. `
                + `Reference it with publisher: ${listing.publisher} to use the listing instead.`,
            });
          }
        }
        return done({ ...shapePlugin(result), source: 'org', publisher: null, imageRepository }, warnings, result.id, result.name);
      }
    }

    // Listings resolve by name (an `id` pins an org row, which didn't match).
    if (typeof rowFilter.name !== 'string' || rowFilter.id !== undefined) return sendEntityNotFound(res, 'Plugin');
    const listed = await resolveListedLookup(scope, { ...(publisher ? { publisher } : {}), name: rowFilter.name, ...(rowFilter.version ? { version: rowFilter.version } : {}) });
    if (listed && 'refused' in listed) {
      const { status, code, message, details } = listed.refused;
      recordLookupRefusal(typeof details.reason === 'string' ? details.reason : String(code));
      ctx.log('WARN', 'Plugin lookup refused', { name: rowFilter.name, publisher, code });
      return sendError(res, status, message, code, details);
    }
    if (!listed) {
      return publisher
        ? sendError(res, 404, `No listing ${publisher}/${rowFilter.name}.`, ErrorCode.NOT_FOUND)
        : sendEntityNotFound(res, 'Plugin');
    }
    const record = listed.record as Record<string, unknown> & { buildType: string; pluginType: string };
    if (pluginRequiresImage(record)) {
      try {
        await verifyListedImage(listed.resolution);
      } catch (err) {
        return verificationFailed(err, record.id, record.name);
      }
    }
    return done(record, listed.resolution.warnings, record.id, record.name);
  };

  router.post('/lookup', meter, requirePermission('plugins:read'), withRoute(async ({ req, res, ctx, orgId }) => {
    const { filter } = req.body ?? {};
    if (!filter || typeof filter !== 'object') return sendBadRequest(res, 'Filter is required in request body', ErrorCode.MISSING_REQUIRED_FIELD);
    const parsed = PluginFilterSchema.safeParse(filter);
    if (!parsed.success) return sendBadRequest(res, `Invalid filter: ${parsed.error.message}`, ErrorCode.VALIDATION_ERROR);
    return respondWithSinglePlugin(parsed.data as PluginFilter, req, res, orgId, ctx, { setCacheHeader: false });
  }));

  // GET /plugins/find — single plugin by filter
  router.get('/find', meter, requirePermission('plugins:read'), withRoute(async ({ req, res, ctx, orgId }) => {
    const validated = validateQuery(req, PluginFilterSchema);
    if (!validated.ok) return sendBadRequest(res, validated.error);
    return respondWithSinglePlugin(validated.value as PluginFilter, req, res, orgId, ctx, { setCacheHeader: true });
  }));

  // GET /plugins/deleted — org's soft-deleted tombstones (most recent first),
  // powering the "recently deleted" restore UI. Registered BEFORE `/:id` so the
  // literal path isn't swallowed by the id matcher.
  router.get('/deleted', meter, requirePermission('plugins:read'), withRoute(async ({ req, res, ctx, orgId }) => {
    const { limit, offset } = parsePaginationParams(req.query as Record<string, unknown>);
    const deleted = await pluginService.findDeleted(orgId, { limit, offset });

    ctx.log('COMPLETED', 'Listed deleted plugins', { count: deleted.length });

    return sendSuccess(res, 200, { plugins: deleted.map(shapePlugin) });
  }));

  // GET /plugins/:id/sbom — the plugin image's SPDX JSON SBOM, read from its
  // SIGNED attestation (so it is exactly what the platform generated and signed
  // at build time). Registered before `/:id`.
  router.get('/:id/sbom', meter, requirePermission('plugins:read'), withRoute(async ({ req, res, ctx, orgId }) => {
    const id = getParam(req.params, 'id');
    if (!id) return sendBadRequest(res, 'Plugin ID is required.', ErrorCode.MISSING_REQUIRED_FIELD);

    const result = await pluginService.findById(id, orgId, parentOrgIdOf(req));
    if (!result) return sendEntityNotFound(res, 'Plugin');
    if (!pluginRequiresImage(result)) {
      return sendError(res, 404, 'Plugin has no image, so no SBOM', ErrorCode.NOT_FOUND);
    }

    let sbom: Record<string, unknown>;
    try {
      sbom = await fetchImageSbom(result, Config.get('registry'));
    } catch (err) {
      if (!(err instanceof ImageVerificationError)) throw err;
      ctx.log('WARN', 'Plugin SBOM failed verification', { id: result.id, name: result.name, error: err.message });
      return sendError(res, 409, err.message, ErrorCode.IMAGE_VERIFICATION_FAILED);
    }

    ctx.log('COMPLETED', 'Retrieved plugin SBOM', { id: result.id, name: result.name });
    res.setHeader('Content-Disposition', attachmentDisposition(`${result.name}-${result.version}.spdx.json`));
    res.status(200).type('application/spdx+json').send(JSON.stringify(sbom));
  }));

  // GET /plugins/:id — single plugin by UUID
  router.get('/:id', meter, requirePermission('plugins:read'), withRoute(async ({ req, res, ctx, orgId }) => {
    const id = getParam(req.params, 'id');

    if (!id) return sendBadRequest(res, 'Plugin ID is required.', ErrorCode.MISSING_REQUIRED_FIELD);

    // Org → team hierarchy: a team org also fetches its parent's public plugins
    // by id (mirrors the list path). No-op for root orgs (claim absent).
    const parentOrgId = parentOrgIdOf(req);
    const result = await pluginService.findById(id, orgId, parentOrgId);

    if (!result) return sendEntityNotFound(res, 'Plugin');

    ctx.log('COMPLETED', 'Retrieved plugin', { id: result.id, name: result.name });

    res.setHeader('Cache-Control', CoreConstants.CACHE_CONTROL_DETAIL);

    return sendSuccess(res, 200, { plugin: shapePlugin(result) });
  }));

  return router;
}
