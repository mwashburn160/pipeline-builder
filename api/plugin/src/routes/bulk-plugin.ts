// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { audited, sendBadRequest, sendError, sendSuccess, ErrorCode, requireFeature, resolveVisibility, isSystemAdmin, checkVisibilityWriteAccess, userHasPermission, VisibilitySchema, actorId } from '@pipeline-builder/api-core';
import { withRoute } from '@pipeline-builder/api-server';
import { CoreConstants } from '@pipeline-builder/pipeline-core';
import { Router } from 'express';
import { z } from 'zod';
import { checkUpdateCompliance, needsComplianceRecheck } from '../helpers/update-compliance.js';
import { emitPluginAudit } from '../services/audit.js';
import { pluginService } from '../services/plugin-service.js';

/**
 * Whitelist of plugin fields that may be set via bulk update.
 * Excludes `orgId`, `id`, `createdAt`, `createdBy`, `deletedAt`, `name`,
 * `version` — those are either tenancy boundaries, immutable, or part of
 * the registry repo path (changing them would orphan pushed images).
 */
const BulkPluginUpdateDataSchema = z.object({
  isActive: z.boolean().optional(),
  isDefault: z.boolean().optional(),
  category: z.string().max(100).optional(),
  description: z.string().max(2000).optional(),
  keywords: z.array(z.string()).optional(),
  visibility: VisibilitySchema.optional(),
}).strict();


/**
 * Bulk `ids`: FULL UUIDs only. The id filter the CRUD layer builds treats a
 * partial id as a PREFIX (`id::text LIKE 'x%'` — a list-search affordance), so a
 * bulk write accepting free-form strings let `ids: ['']` (or `['a']`) match every
 * plugin in the org (or ~1/16 of it) — and the per-row visibility check, which
 * loads rows by EXACT id, never saw those rows at all.
 */
const BulkIdsSchema = z.array(z.string().uuid()).min(1).max(CoreConstants.MAX_BULK_ITEMS);

/** Parse `ids`, or send the 400 and return null. */
function parseBulkIds(res: Parameters<typeof sendBadRequest>[0], raw: unknown): string[] | null {
  if (!Array.isArray(raw) || raw.length === 0) {
    sendBadRequest(res, 'Request body must include a non-empty "ids" array', ErrorCode.VALIDATION_ERROR);
    return null;
  }
  if (raw.length > CoreConstants.MAX_BULK_ITEMS) {
    sendBadRequest(res, `Maximum ${CoreConstants.MAX_BULK_ITEMS} items per bulk operation`, ErrorCode.VALIDATION_ERROR);
    return null;
  }
  const parsed = BulkIdsSchema.safeParse(raw);
  if (!parsed.success) {
    sendBadRequest(res, '"ids" must be full plugin UUIDs', ErrorCode.VALIDATION_ERROR);
    return null;
  }
  return parsed.data;
}

/**
 * Register bulk operation routes for plugins.
 *
 * Expects auth + orgId + `plugins:write` at the parent mount (index.ts). The
 * `bulk_operations` feature gate is attached to each route HERE, not the mount:
 * the mount's gates are prefix layers that also run for every request falling
 * through to later routers (purge/restore), which must not require the feature.
 */
export function createBulkPluginRoutes(): Router {
  const router: Router = Router();
  const bulkFeature = requireFeature('bulk_operations');

  /** POST /plugins/bulk/delete — Soft-delete multiple plugins by ID */
  router.post('/bulk/delete', bulkFeature, audited('plugin.bulk.delete'), withRoute(async ({ req, res, ctx, orgId, userId }) => {
    const ids = parseBulkIds(res, req.body?.ids);
    if (!ids) return;

    ctx.log('INFO', 'Bulk delete plugins', { count: ids.length });

    // Same visibility rule as single-row delete, applied per row inside the
    // query: author-only for `private`, any member for `org`, and
    // `plugins:publish` for `public`. Rows the caller may not delete are
    // skipped rather than failing the batch. This previously narrowed to
    // `private` ONLY, which skipped the DEFAULT rung (`org`) that single-row
    // delete allows — so bulk delete silently did nothing for normal plugins.
    const deleted = await pluginService.bulkDelete(ids, orgId, userId, {
      isSystemAdmin: isSystemAdmin(req),
      canPublish: userHasPermission(req, 'plugins:publish'),
    });

    ctx.log('COMPLETED', 'Bulk delete complete', { requested: ids.length, deleted: deleted.length });

    // Best-effort attributed audit — ONE event per bulk op, emitted only when
    // rows actually landed. Ids are bounded by MAX_BULK_ITEMS so they're safe to
    // record; plugin ids carry no secrets / AWS account ids.
    if (deleted.length > 0) {
      const deletedIds = deleted.map(d => d.id);
      emitPluginAudit({
        action: 'plugin.bulk.delete',
        actorId: actorId({ userId }),
        orgId,
        targetType: 'plugin',
        details: { count: deletedIds.length, ids: deletedIds },
      });
    }

    return sendSuccess(res, 200, { deleted: deleted.length, ids: deleted.map(d => d.id) });
  }));

  /** PUT /plugins/bulk/update — Update multiple plugins with the same data */
  router.put('/bulk/update', bulkFeature, audited('plugin.bulk.update'), withRoute(async ({ req, res, ctx, orgId, userId }) => {
    const ids = parseBulkIds(res, req.body?.ids);
    if (!ids) return;
    const data = req.body?.data;

    if (!data || typeof data !== 'object') {
      return sendBadRequest(res, 'Request body must include a "data" object with fields to update', ErrorCode.VALIDATION_ERROR);
    }

    // Validate the update payload against a strict whitelist — without this,
    // a caller could write internal fields (orgId, deletedAt) or rename
    // (name, version) every plugin in the org with one call.
    const dataValidation = BulkPluginUpdateDataSchema.safeParse(data);
    if (!dataValidation.success) {
      return sendBadRequest(res, `Invalid update data: ${dataValidation.error.message}`, ErrorCode.VALIDATION_ERROR);
    }

    // Same escalation guard the single-update path applies: only admins/owners
    // may set `visibility: 'public'`. Without this, any member with the
    // bulk-ops feature could flip every plugin in the org to public.
    const updateData = { ...dataValidation.data };
    if (updateData.visibility !== undefined) {
      updateData.visibility = resolveVisibility(req, updateData.visibility, 'plugins:publish');
    }

    // A default is singular per (name, org). Bulk-setting `isDefault: true` fans
    // out a plain UPDATE, bypassing deployVersion/setDefault's clear-others
    // transaction and leaving several defaults. Promote one via PUT /plugins/:id.
    // (Bulk-clearing `false` is fine.) Mirrors bulk pipeline update.
    if (updateData.isDefault === true) {
      return sendBadRequest(res, 'Cannot set isDefault=true in bulk; promote a default via PUT /plugins/:id', ErrorCode.VALIDATION_ERROR);
    }

    // Same per-row visibility rule as single-row update (requireVisibilityWriteAccess):
    // `public` needs plugins:publish, `private` is author-only, `org` any member.
    // updateMany's read predicate already hides other authors' private rows, but
    // it happily matches PUBLIC rows — so without this a member could bulk-edit
    // (deactivate, re-describe, or downgrade to `org`) a published plugin.
    // Loaded once for both per-row gates below (visibility for non-admins, and
    // the compliance re-check for everyone).
    const recheck = needsComplianceRecheck(updateData);
    const matched = (!isSystemAdmin(req) || recheck) ? await pluginService.findByIds(ids, orgId) : [];
    if (!isSystemAdmin(req)) {
      const forbidden = matched.filter(
        (p) => checkVisibilityWriteAccess(req, p, userId, 'plugins:publish') !== 'ok',
      );
      if (forbidden.length > 0) {
        return sendError(
          res,
          403,
          'Bulk update rejected: you cannot modify one or more of these plugins',
          ErrorCode.INSUFFICIENT_PERMISSIONS,
          { ids: forbidden.map((p) => p.id) },
        );
      }
    }

    // Same fail-closed compliance re-check as single-row update, per row: a bulk
    // edit (e.g. flipping visibility) must not turn a compliant plugin
    // non-compliant. Any block rejects the whole batch (mirrors the visibility
    // gate above); an unreachable compliance service rejects it with 503.
    if (recheck) {
      const blocked: Array<{ id: string; violations: unknown[] }> = [];
      for (const plugin of matched) {
        const verdict = await checkUpdateCompliance(orgId, plugin, updateData);
        if (verdict.outcome === 'unavailable') {
          ctx.log('ERROR', 'Compliance service unavailable — bulk plugin update rejected', { error: verdict.error });
          return sendError(res, 503, 'Compliance service unavailable — plugin update rejected', ErrorCode.COMPLIANCE_SERVICE_UNAVAILABLE);
        }
        if (verdict.outcome === 'blocked') blocked.push({ id: plugin.id, violations: verdict.violations });
      }
      if (blocked.length > 0) {
        ctx.log('WARN', 'Bulk plugin update blocked by compliance', { blocked: blocked.length });
        return sendError(res, 403, 'Bulk update blocked by compliance rules', ErrorCode.COMPLIANCE_VIOLATION, { blocked });
      }
    }

    ctx.log('INFO', 'Bulk update plugins', { count: ids.length });

    // pluginService.updateMany runs the per-row post-update lifecycle (cache
    // invalidation + compliance entity event), same as a single-row update.
    const updated = await pluginService.updateMany(
      { id: ids },
      updateData,
      orgId,
      userId,
    );

    ctx.log('COMPLETED', 'Bulk update complete', { requested: ids.length, updated: updated.length });

    // Best-effort attributed audit — ONE event per bulk op, emitted only when
    // rows actually changed. Ids are bounded by MAX_BULK_ITEMS so they're safe
    // to record; plugin ids carry no secrets / AWS account ids.
    if (updated.length > 0) {
      const updatedIds = updated.map(u => u.id);
      emitPluginAudit({
        action: 'plugin.bulk.update',
        actorId: actorId({ userId }),
        orgId,
        targetType: 'plugin',
        details: { count: updatedIds.length, ids: updatedIds, fields: Object.keys(updateData) },
      });
    }

    return sendSuccess(res, 200, { updated: updated.length });
  }));

  return router;
}
