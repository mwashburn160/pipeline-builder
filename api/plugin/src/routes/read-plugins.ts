// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import {
  attachmentDisposition, getParam, ErrorCode, isManagedToolchainPlugin, isSystemOrgId, managedRefPinsVersion, requirePermission, sendBadRequest, sendError, sendSuccess, sendPaginatedNested,
  parsePaginationParams, validateQuery, PluginFilterSchema, sendEntityNotFound, maxSeverity, severityAtLeast,
  parseVulnWaivers, SYSTEM_ORG_ID, TOOLCHAIN_RELEASE_VERSION_PATTERN, MANAGED_TOOLCHAIN,
} from '@pipeline-builder/api-core';
import type { ManagedToolchainPlugin, VulnSeverity, VulnWarning } from '@pipeline-builder/api-core';
import { incCounter, withRoute } from '@pipeline-builder/api-server';
import type { RequestContext } from '@pipeline-builder/api-server';
import { Config, CoreConstants, pluginImageRepository } from '@pipeline-builder/pipeline-core';
import {
  bootstrapToolchainOf, compareSemver, executeRows, isVersionRange, ManagedToolchainError, recordStepLookup,
  resolveManagedToolchain, vulnUpgradeAvailableWarning, withTenantTx,
} from '@pipeline-builder/pipeline-data';
import type { PluginFilter, VulnUpgradeAvailableWarning } from '@pipeline-builder/pipeline-data';
import { sql } from 'drizzle-orm';
import type { Request, Response } from 'express';
import { Router } from 'express';
import { registerVulnerabilityRoutes } from './plugin-vulnerabilities.js';
import { acceptancesFor, assessmentFor, consumptionPolicyFor, NO_ACCEPTANCES, ownedPipeline } from '../helpers/lookup-vuln-policy.js';
import { isYankedVersion } from '../helpers/managed-toolchain.js';
import { pipelinePluginRefs } from '../helpers/pipeline-plugin-refs.js';
import { pluginRequiresImage, shapePlugin } from '../helpers/plugin-helpers.js';
import { fetchImageSbom, ImageVerificationError, verifyImageSignature } from '../helpers/supply-chain.js';
import { resolveListedLookup, shadowedListing, verifyListedImage } from '../services/ecosystem/lookup.js';
import { pluginRowState } from '../services/plugin-row-state.js';
import { notifyPipelineVulnerable } from '../services/plugin-security-notifications.js';
import { pluginService } from '../services/plugin-service.js';

/** The caller's parent-org id (org→team hierarchy), carried in the JWT; absent
 *  for root orgs. Centralizes the one cast the read handlers all need. */
function parentOrgIdOf(req: Request): string | undefined {
  return (req.user as { parentOrganizationId?: string } | undefined)?.parentOrganizationId;
}

/**
 * A warning attached to a lookup answer (lifecycle, listings, advisories, and
 * the severity-graded vulnerability assessment). Every warning carries a
 * `severity`; the answer's own `severity` is the loudest of them. Vulnerability
 * state never refuses a lookup — it only makes the answer louder.
 */
export type LookupWarning =
  | { code: 'PLUGIN_DEPRECATED' | 'PLUGIN_YANKED' | 'PLUGIN_SHADOWS_LISTING' | 'PLUGIN_SECRETS_WITHHELD' | 'LISTING_UNMAINTAINED' | 'PLUGIN_ADVISORY'; severity: VulnSeverity; message: string }
  /** A managed toolchain release's standing (yanked / deprecated / inactive / never promoted). */
  | { code: `TOOLCHAIN_${string}`; severity: VulnSeverity; message: string }
  | VulnUpgradeAvailableWarning
  | VulnWarning;

/** How loud each non-vulnerability lookup warning is. */
const WARNING_SEVERITY: Record<string, VulnSeverity> = {
  PLUGIN_YANKED: 'warning',
  PLUGIN_DEPRECATED: 'warning',
  LISTING_UNMAINTAINED: 'warning',
  PLUGIN_ADVISORY: 'error',
  PLUGIN_SHADOWS_LISTING: 'info',
  PLUGIN_SECRETS_WITHHELD: 'info',
};

/** A resolution warning with its severity (the resolver's own carry none, or the flag's). */
function graded(w: { code: string; message: string; severity?: VulnSeverity }): LookupWarning {
  return { ...w, severity: w.severity ?? WARNING_SEVERITY[w.code] ?? 'info' } as LookupWarning;
}

/** The loudest severity of a lookup's warnings (null when it has none). */
function answerSeverity(warnings: readonly LookupWarning[]): VulnSeverity | null {
  return warnings.reduce<VulnSeverity | null>((acc, w) => (acc ? maxSeverity(acc, w.severity) : w.severity), null);
}

/**
 * `context` on `POST /plugins/lookup`: the pipeline STEPS synth is resolving —
 * each named by its label (`pluginStepLabel`: `synth` or `<stage>/<alias ?? name>`,
 * the key the step manifest and the declared resolution rows use). The CLI
 * de-duplicates references by alias, so one lookup may serve several steps; the
 * deploy-time custom resource sends one.
 * When the caller's org owns the pipeline, the outcome is recorded per step
 * (`pipeline_step_lookups`, read by `GET /plugins/pipelines/:id/security`), the
 * pipeline's active risk acceptances downgrade what they accepted, and an answer
 * at `error` or louder tells the pipeline's owners (N32). A context naming a pipeline the org does not own
 * is ignored — the lookup itself is unchanged.
 */
export interface LookupContext {
  pipelineId: string;
  stepKeys: string[];
}

/** Steps one lookup context may name (a pipeline's steps sharing one alias). */
const MAX_CONTEXT_STEP_KEYS = 200;

/** The validated `context`, or null when absent; a string error when malformed. */
export function parseLookupContext(raw: unknown): LookupContext | null | string {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) return 'context must be an object';
  const { pipelineId, stepKeys } = raw as Record<string, unknown>;
  if (typeof pipelineId !== 'string' || !/^[0-9a-f-]{36}$/i.test(pipelineId)) return 'context.pipelineId must be a pipeline id';
  if (!Array.isArray(stepKeys) || stepKeys.length === 0 || stepKeys.length > MAX_CONTEXT_STEP_KEYS
    || stepKeys.some((k) => typeof k !== 'string' || k.trim() === '' || k.length > 512)) {
    return `context.stepKeys must be 1-${MAX_CONTEXT_STEP_KEYS} non-empty strings (at most 512 characters each)`;
  }
  return { pipelineId: pipelineId.toLowerCase(), stepKeys: [...new Set((stepKeys as string[]).map((k) => k.trim()))] };
}

/** The lifecycle warnings a resolved version carries (empty for a healthy one). */
export function lookupWarnings(plugin: {
  name: string;
  version: string;
  lifecycle?: string | null;
  yankedAt?: Date | string | null;
  yankReason?: string | null;
  deprecatedAt?: Date | string | null;
  deprecationMessage?: string | null;
}): LookupWarning[] {
  const ref = `${plugin.name}@${plugin.version}`;
  const warnings: LookupWarning[] = [];
  if (isYankedVersion(plugin)) {
    warnings.push({
      code: 'PLUGIN_YANKED',
      severity: 'warning',
      message: `Plugin ${ref} is yanked${plugin.yankReason ? `: ${plugin.yankReason}` : ''}. It resolves only because it is pinned exactly; move to a supported version.`,
    });
  }
  if (plugin.deprecatedAt || plugin.lifecycle === 'deprecated') {
    warnings.push({
      code: 'PLUGIN_DEPRECATED',
      severity: 'warning',
      message: `Plugin ${ref} is deprecated${plugin.deprecationMessage ? `: ${plugin.deprecationMessage}` : ''}.`,
    });
  }
  // The scan side (flag, KEV, fixable findings, freshness, compliance) is the
  // shared vulnerability assessment's, added by the lookup.
  return warnings;
}

/**
 * `releasePin` on a lookup of a managed toolchain name (pipeline-bootstrap,
 * cdk-synth): the pipeline's `toolchain.release`. Undefined when absent; a
 * string error when malformed.
 */
export function parseReleasePin(raw: unknown): string | undefined | { error: string } {
  if (raw === undefined || raw === null || raw === '') return undefined;
  if (typeof raw !== 'string' || !TOOLCHAIN_RELEASE_VERSION_PATTERN.test(raw.trim())) {
    return { error: 'releasePin must be a toolchain release version (MAJOR.MINOR.PATCH, e.g. 1.4.2)' };
  }
  return raw.trim();
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
export function resolutionFilter(filter: PluginFilter): PluginFilter {
  const pinned = isPinnedFilter(filter);
  return {
    ...filter,
    ...(filter.name !== undefined ? { nameMatch: 'exact' as const } : {}),
    ...(pinned ? {} : { excludeYanked: true }),
  };
}

/** Lookup refusal reasons, as `plugin_lookup_refusals_total{reason}` reports them. */
const LOOKUP_REFUSAL_REASONS: Record<string, string> = {
  yanked: 'yank', blocked_listing: 'policy', deleted: 'deleted',
};

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
 * apiCalls is metered + checked by the '/plugins' prefix mount (app-routes.ts).
 */
export function createReadPluginRoutes(): Router {
  const router: Router = Router();

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
  //
  // `versions` is the same question at VERSION + DIGEST granularity, keyed by
  // the RESOLVED identity (`plugin`, `publisher`): how many live pipelines DECLARE
  // each version/image (their config resolves to it — `pipeline_plugin_resolution`)
  // and how many RUN it (their last deploy's step manifest). "Used by 12" says
  // nothing about whether any of the 12 is on the vulnerable image; this does.
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
    const versionRows = await withTenantTx(async (tx) => executeRows<{
      plugin: string; publisher: string | null; version: string; image_digest: string | null; deployed: string | number; declared: string | number;
    }>(tx, sql`
      SELECT x.plugin, x.publisher, x.version, x.image_digest,
             COUNT(DISTINCT x.pipeline_id) FILTER (WHERE x.source = 'deployed') AS deployed,
             COUNT(DISTINCT x.pipeline_id) FILTER (WHERE x.source = 'declared') AS declared
        FROM (
          SELECT m.plugin_name AS plugin, m.plugin_publisher AS publisher, m.plugin_version AS version,
                 m.image_digest, m.pipeline_id::text AS pipeline_id, 'deployed' AS source
            FROM pipeline_step_manifests m
           WHERE m.org_id = ${orgId}
          UNION ALL
          SELECT r.plugin_name, r.plugin_publisher, r.resolved_version, r.resolved_digest, r.pipeline_id, 'declared'
            FROM pipeline_plugin_resolution r
           WHERE r.org_id = ${orgId} AND r.resolved_version IS NOT NULL
        ) x
        JOIN pipelines p ON p.id::text = x.pipeline_id AND p.is_active = true AND p.deleted_at IS NULL AND p.org_id = ${orgId}
       GROUP BY 1, 2, 3, 4
       ORDER BY 1, 2, 3
    `));
    const toInt = (v: string | number) => (typeof v === 'number' ? v : parseInt(String(v), 10) || 0);
    const versions = versionRows.map((v) => ({
      plugin: v.plugin,
      publisher: v.publisher ?? null,
      version: v.version,
      imageDigest: v.image_digest ?? null,
      deployedPipelines: toInt(v.deployed),
      declaredPipelines: toInt(v.declared),
    }));
    ctx.log('COMPLETED', 'Computed plugin usage', { distinct: Object.keys(counts).length, versions: versions.length });
    res.setHeader('Cache-Control', CoreConstants.CACHE_CONTROL_LIST);
    return sendSuccess(res, 200, { counts, versions });
  }));

  // GET /plugins — paginated list
  router.get('/', requirePermission('plugins:read'), withRoute(async ({ req, res, ctx, orgId }) => {
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
    opts: { setCacheHeader: boolean; context?: LookupContext | null; releasePin?: string },
  ) => {
    // Org → team hierarchy: a team org also sees its parent's public plugins
    // (mirrors the list path). No-op for root orgs (claim absent).
    const parentOrgId = parentOrgIdOf(req);
    const scope = { orgId, ...(parentOrgId ? { rootOrgId: parentOrgId } : {}) };
    const { publisher, ...rowFilter } = filter;
    // A step context counts only for a pipeline this org owns.
    const pipeline = opts.context ? await ownedPipeline(orgId, opts.context.pipelineId) : null;
    if (opts.context && !pipeline) ctx.log('WARN', 'Lookup context names a pipeline outside the org; ignored', { pipelineId: opts.context.pipelineId });
    const context = pipeline && opts.context ? opts.context : null;
    const acceptances = context ? await acceptancesFor(orgId, context.pipelineId) : NO_ACCEPTANCES;
    // Record what synth was told, once per step the lookup serves (never fails the lookup).
    const record = (outcome: {
      plugin?: { id?: unknown; name?: unknown; version?: unknown; imageDigest?: unknown; publisher?: unknown };
      warnings?: LookupWarning[];
      refusal?: { code: string; reason: string; message: string };
    }) => {
      if (!context) return;
      const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
      const row = {
        orgId,
        pipelineId: context.pipelineId,
        pluginPublisher: str(outcome.plugin?.publisher) ?? publisher ?? null,
        pluginName: str(outcome.plugin?.name) ?? (typeof rowFilter.name === 'string' ? rowFilter.name : '(unknown)'),
        requestedVersion: typeof rowFilter.version === 'string' ? rowFilter.version : null,
        resolvedVersion: str(outcome.plugin?.version),
        resolvedPluginId: str(outcome.plugin?.id),
        imageDigest: str(outcome.plugin?.imageDigest),
        warnings: (outcome.warnings ?? []).map((w) => ({ code: w.code, message: w.message, severity: w.severity })),
        refusal: outcome.refusal ?? null,
      };
      for (const stepKey of context.stepKeys) {
        void recordStepLookup({ ...row, stepKey })
          .catch((err: unknown) => ctx.log('WARN', 'Step lookup not recorded', { pipelineId: context.pipelineId, stepKey, error: String(err) }));
      }
    };
    const done = (plugin: Record<string, unknown> & { name: string; version: string }, warnings: LookupWarning[], suggestedVersion: string | null, extra: Record<string, unknown> = {}) => {
      const severity = answerSeverity(warnings);
      ctx.log('COMPLETED', 'Plugin lookup', { id: plugin.id, name: plugin.name, ...(publisher ? { publisher } : {}), ...(warnings.length ? { warnings: warnings.map((w) => w.code), severity } : {}) });
      record({ plugin, warnings });
      // A pipeline about to run a version graded `error` or louder: its owners hear it.
      if (context && pipeline && severity && severityAtLeast(severity, 'error')) {
        void notifyPipelineVulnerable({
          orgId,
          pipelineId: pipeline.id,
          pipelineName: pipeline.name,
          stepKey: context.stepKeys.join(', '),
          plugin: typeof plugin.publisher === 'string' && plugin.publisher ? `${plugin.publisher}/${plugin.name}` : plugin.name,
          version: plugin.version,
          severity,
          warnings: warnings.filter((w) => severityAtLeast(w.severity, 'error')).map((w) => ({ code: w.code, severity: w.severity, message: w.message })),
          suggestedVersion,
          trigger: 'lookup',
        });
      }
      if (opts.setCacheHeader) res.setHeader('Cache-Control', CoreConstants.CACHE_CONTROL_LIST);
      return sendSuccess(res, 200, { plugin, warnings, severity, ...extra });
    };
    const refused = (status: number, message: string, code: ErrorCode, details: Record<string, unknown> | undefined, plugin?: Record<string, unknown>) => {
      const reason = typeof details?.reason === 'string' ? details.reason : String(code);
      record({ ...(plugin ? { plugin } : {}), refusal: { code, reason, message } });
      return sendError(res, status, message, code, details);
    };
    // The org's consumption policy (its fixable-High threshold) and the pipeline's
    // acceptances feed the ONE assessment lookup, runtime-check and the save-time
    // check share. It grades what resolved; it never refuses.
    const policy = await consumptionPolicyFor(scope);
    const verificationFailed = (err: unknown, plugin: Record<string, unknown>) => {
      if (!(err instanceof ImageVerificationError)) throw err;
      recordLookupRefusal('signature');
      ctx.log('WARN', 'Plugin image failed verification', { id: plugin.id, name: plugin.name, error: err.message });
      return refused(409, err.message, ErrorCode.IMAGE_VERIFICATION_FAILED, undefined, plugin);
    };

    // A MANAGED toolchain name answers from the toolchain resolver and nothing
    // else — with or without a publisher, for the system org too — so a
    // same-named row or listing anywhere is never a candidate
    // (docs/plans/bootstrap-image-versioning.md §2).
    if (typeof rowFilter.name === 'string' && isManagedToolchainPlugin(rowFilter.name)) {
      const name = rowFilter.name.trim().toLowerCase() as ManagedToolchainPlugin;
      if (managedRefPinsVersion(rowFilter)) {
        return refused(400, `${name} is part of the managed toolchain and can't be pinned on its own: remove filter.version / id and pin the whole release with toolchain.release.`,
          ErrorCode.TOOLCHAIN_PIN_VIA_RELEASE, { reason: 'pin_via_release', name });
      }
      let resolution;
      try {
        resolution = await resolveManagedToolchain({ orgId }, opts.releasePin ? { releasePin: opts.releasePin } : {});
      } catch (err) {
        if (!(err instanceof ManagedToolchainError)) throw err;
        const reason = typeof err.details?.reason === 'string' ? err.details.reason : String(err.code);
        recordLookupRefusal(reason);
        ctx.log('WARN', 'Toolchain lookup refused', { name, code: err.code });
        return refused(err.statusCode, err.message, err.code, { ...(err.details ?? {}), reason });
      }
      const half = name === MANAGED_TOOLCHAIN.bootstrap ? resolution.bootstrap : resolution.synth;
      const imageRepository = pluginImageRepository(half);
      const shaped = {
        ...shapePlugin(half),
        source: 'org',
        publisher: null,
        imageRepository,
        ...(name === MANAGED_TOOLCHAIN.bootstrap ? { toolchain: bootstrapToolchainOf(half) } : {}),
      } as Record<string, unknown> & { name: string; version: string };
      // Both halves run an image synth pins by digest: never hand out one whose
      // signature doesn't verify.
      try {
        await verifyImageSignature({ ...half, imageRepository }, Config.get('registry'));
      } catch (err) {
        return verificationFailed(err, shaped);
      }
      const assessment = await assessmentFor({ orgId, record: half, policy, acceptances, suggestedVersion: null });
      const warnings: LookupWarning[] = [...resolution.warnings.map(graded), ...assessment.warnings];
      return done(shaped, warnings, null, { toolchain: { releaseVersion: resolution.releaseVersion, resolvedVia: resolution.resolvedVia } });
    }

    if (!publisher) {
      const result = await pluginService.findFirst(resolutionFilter(rowFilter), orgId, parentOrgId);
      if (result) {
        // For a FLAGGED answer, the version to move to: the newest unflagged live one.
        const newest = result.scanFlaggedAt && result.name
          ? await pluginService.findFirst({ ...resolutionFilter({ name: result.name, isActive: true } as PluginFilter), excludeScanFlagged: true }, orgId, parentOrgId)
          : null;
        const suggestedVersion = newest && compareSemver(newest.version, result.version) > 0 ? newest.version : null;
        const assessment = await assessmentFor({ orgId, record: result, policy, acceptances, suggestedVersion });
        const shaped = { ...shapePlugin(result), source: 'org', publisher: null } as Record<string, unknown> & { name: string; version: string };
        const imageRepository = pluginImageRepository(result);
        // These are the endpoints synth resolves plugins through, and synth pins
        // CodeBuild to the returned `imageDigest` — so never hand out a digest whose
        // signature doesn't verify against the plugin-signing key (or a plugin that
        // needs an image but has no signed digest at all).
        if (pluginRequiresImage(result)) {
          try {
            await verifyImageSignature({ ...result, imageRepository }, Config.get('registry'));
          } catch (err) {
            return verificationFailed(err, shaped);
          }
        }
        // Deprecated / yanked-but-pinned versions still resolve, with a warning the
        // caller surfaces (synth prints it).
        const warnings: LookupWarning[] = [...lookupWarnings(result), ...assessment.warnings];
        if (suggestedVersion && isPinnedFilter(rowFilter)) {
          warnings.push(vulnUpgradeAvailableWarning(result.name, result.version, suggestedVersion));
        }
        if (rowFilter.name && !isSystemOrgId(orgId)) {
          const listing = await shadowedListing(scope, result.name);
          if (listing) {
            warnings.push({
              code: 'PLUGIN_SHADOWS_LISTING',
              severity: 'info',
              message: `Your organization's plugin ${result.name} shadows the Official listing ${listing.publisher}/${listing.name}. `
                + `Reference it with publisher: ${listing.publisher} to use the listing instead.`,
            });
          }
        }
        return done({ ...shaped, imageRepository }, warnings, suggestedVersion);
      }
    }

    // Listings resolve by name (an `id` pins an org row, which didn't match).
    if (typeof rowFilter.name !== 'string' || rowFilter.id !== undefined) {
      const state = await pluginRowState(scope, rowFilter);
      return refused(404, 'Plugin not found.', ErrorCode.NOT_FOUND, { reason: 'not_found', state });
    }
    // An UNQUALIFIED reference to a name the org DELETED must not fall through to
    // a same-named listing: that silently swaps the image a pipeline runs.
    if (!publisher && !isSystemOrgId(orgId)) {
      const state = await pluginRowState(scope, rowFilter);
      if (state === 'deleted') {
        recordLookupRefusal('deleted');
        return refused(410, `Plugin ${rowFilter.name} was deleted in your organization; it no longer resolves, and the reference does not fall back to a listing of the same name. `
          + 'Restore it, or reference a listing explicitly with publisher.', ErrorCode.PLUGIN_DELETED, { reason: 'deleted', state, name: rowFilter.name });
      }
    }
    const listed = await resolveListedLookup(scope, { ...(publisher ? { publisher } : {}), name: rowFilter.name, ...(rowFilter.version ? { version: rowFilter.version } : {}) });
    if (listed && 'refused' in listed) {
      const { status, code, message, details } = listed.refused;
      recordLookupRefusal(typeof details.reason === 'string' ? details.reason : String(code));
      ctx.log('WARN', 'Plugin lookup refused', { name: rowFilter.name, publisher, code });
      return refused(status, message, code, details);
    }
    if (!listed) {
      if (publisher) return refused(404, `No listing ${publisher}/${rowFilter.name}.`, ErrorCode.NOT_FOUND, { reason: 'not_found', state: 'missing' });
      const state = await pluginRowState(scope, rowFilter);
      return refused(404, 'Plugin not found.', ErrorCode.NOT_FOUND, { reason: 'not_found', state });
    }
    const listedRecord = listed.record as Record<string, unknown> & { buildType: string; pluginType: string; name: string; version: string };
    // The listed resolution applied the org's install and advisory policy; the
    // assessment grades the version's scan state under the pipeline's acceptances.
    const assessment = await assessmentFor({ orgId, record: listedRecord, policy, acceptances, suggestedVersion: listed.resolution.suggestedVersion });
    if (pluginRequiresImage(listedRecord)) {
      try {
        await verifyListedImage(listed.resolution);
      } catch (err) {
        return verificationFailed(err, listedRecord);
      }
    }
    // The resolver's own VULN_FLAGGED is superseded by the assessment's (which
    // knows the pipeline's acceptances).
    const resolutionWarnings = listed.resolution.warnings.filter((w) => w.code !== 'VULN_FLAGGED').map(graded);
    return done(listedRecord, [...resolutionWarnings, ...assessment.warnings], listed.resolution.suggestedVersion);
  };

  router.post('/lookup', requirePermission('plugins:read'), withRoute(async ({ req, res, ctx, orgId }) => {
    const { filter, context, releasePin } = req.body ?? {};
    if (!filter || typeof filter !== 'object') return sendBadRequest(res, 'Filter is required in request body', ErrorCode.MISSING_REQUIRED_FIELD);
    const parsed = PluginFilterSchema.safeParse(filter);
    if (!parsed.success) return sendBadRequest(res, `Invalid filter: ${parsed.error.message}`, ErrorCode.VALIDATION_ERROR);
    const lookupContext = parseLookupContext(context);
    if (typeof lookupContext === 'string') return sendBadRequest(res, lookupContext, ErrorCode.VALIDATION_ERROR);
    const pin = parseReleasePin(releasePin);
    if (typeof pin === 'object') return sendBadRequest(res, pin.error, ErrorCode.VALIDATION_ERROR);
    return respondWithSinglePlugin(parsed.data as PluginFilter, req, res, orgId, ctx, { setCacheHeader: false, context: lookupContext, ...(pin ? { releasePin: pin } : {}) });
  }));

  // GET /plugins/find — single plugin by filter
  router.get('/find', requirePermission('plugins:read'), withRoute(async ({ req, res, ctx, orgId }) => {
    const { releasePin, ...query } = req.query as Record<string, unknown>;
    const validated = validateQuery({ query } as unknown as Request, PluginFilterSchema);
    if (!validated.ok) return sendBadRequest(res, validated.error);
    const pin = parseReleasePin(releasePin);
    if (typeof pin === 'object') return sendBadRequest(res, pin.error, ErrorCode.VALIDATION_ERROR);
    // A pinned answer is the pin's; the shared list cache-control would still be
    // correct (a release is immutable), so it is kept.
    return respondWithSinglePlugin(validated.value as PluginFilter, req, res, orgId, ctx, { setCacheHeader: true, ...(pin ? { releasePin: pin } : {}) });
  }));

  // GET /plugins/deleted — org's soft-deleted tombstones (most recent first),
  // powering the "recently deleted" restore UI. Registered BEFORE `/:id` so the
  // literal path isn't swallowed by the id matcher.
  router.get('/deleted', requirePermission('plugins:read'), withRoute(async ({ req, res, ctx, orgId }) => {
    const { limit, offset } = parsePaginationParams(req.query as Record<string, unknown>);
    const deleted = await pluginService.findDeleted(orgId, { limit, offset });

    ctx.log('COMPLETED', 'Listed deleted plugins', { count: deleted.length });

    return sendSuccess(res, 200, { plugins: deleted.map(shapePlugin) });
  }));

  // GET /plugins/vuln-waivers — the exemptions currently in force
  // (PLUGIN_VULN_WAIVERS), so a blocked build can say whether one applies.
  //
  // Readable with `plugins:read` rather than reserved to an admin: a waiver is
  // deployment POLICY, not a secret, and the people it affects most are the
  // authors whose builds it does or does not cover. Telling them "blocked" while
  // hiding whether an exemption exists is the opposite of the visibility this
  // control is supposed to have.
  //
  // READ-ONLY by design, and there is no write counterpart. A waiver makes the
  // gate pass, so it belongs in deployment config where it is version
  // controlled, reviewed in a diff and carries an expiry — not behind a button
  // that anyone reaching this page could press, with no record of why.
  //
  // Registered before `/:id`, which would otherwise match "vuln-waivers".
  //
  // A waiver applies ONLY to a plugin owned by the system org (see
  // applyVulnWaivers: names are unique per org, so a tenant naming its plugin
  // `artillery` must not inherit the operator's exemption), and a `*` entry to
  // EVERY system-org plugin. Both facts are returned so the UI can say whether a
  // waiver covers the plugin in front of it by comparing the plugin's `orgId`
  // with `systemOrgId` — rather than showing a tenant's blocked build a waiver
  // that, by name alone, looks like it should have applied.
  router.get('/vuln-waivers', requirePermission('plugins:read'), withRoute(async ({ res, ctx }) => {
    const waivers = parseVulnWaivers().map((w) => ({
      plugin: w.plugin,
      version: w.version,
      packages: w.packages,
      expires: w.expires.toISOString(),
      // Computed here rather than in the browser: the client's clock is not the
      // one the gate uses, and an exemption that looks live locally but expired
      // on the server is exactly the confusion this endpoint exists to remove.
      expired: w.expires.getTime() < Date.now(),
      // A fleet-wide `*` entry covers every system-org plugin (advisory ids only).
      allPlugins: w.plugin === '*',
    }));
    ctx.log('COMPLETED', 'Listed vulnerability waivers', { count: waivers.length });
    return sendSuccess(res, 200, { waivers, systemOrgOnly: true, systemOrgId: SYSTEM_ORG_ID });
  }));

  // Advisory search, per-version findings and the fleet posture view.
  // Registered before `/:id`, which would otherwise match them.
  registerVulnerabilityRoutes(router);

  // GET /plugins/:id/sbom — the plugin image's SPDX JSON SBOM, read from its
  // SIGNED attestation (so it is exactly what the platform generated and signed
  // at build time). Registered before `/:id`.
  router.get('/:id/sbom', requirePermission('plugins:read'), withRoute(async ({ req, res, ctx, orgId }) => {
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
  router.get('/:id', requirePermission('plugins:read'), withRoute(async ({ req, res, ctx, orgId }) => {
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
