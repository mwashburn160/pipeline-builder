// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import {
  sendBadRequest,
  sendError,
  sendSuccess,
  ErrorCode,
  errorMessage,
  requireFeature,
  requirePermission,
  validateBulkArray,
  PipelineCreateSchema,
  PipelineUpdateSchema,
  isSystemAdmin,
  checkVisibilityWriteAccess,
  userHasPermission,
  audited,
  actorId,
  proposable,
  recordAudit,
} from '@pipeline-builder/api-core';
import type { QuotaService } from '@pipeline-builder/api-core';
import { createAuthenticatedWithOrgRoute, withQuotaReservation, withRoute } from '@pipeline-builder/api-server';
import { CoreConstants } from '@pipeline-builder/pipeline-core';
import { Router } from 'express';
import { z } from 'zod';
import { checkPipelineUpdateCompliance, isComplianceRelevantUpdate } from '../helpers/pipeline-update-compliance.js';
import { buildPipelineUpdateData, createOnePipeline, preparePipelineCreate, validatePipelineWrite } from '../helpers/pipeline-write.js';
import { pipelineService, type PipelineUpdate } from '../services/pipeline-service.js';

/**
 * Bulk update/delete `ids` must be FULL UUIDs. `pipelineService.update(id)` goes
 * through the CRUD layer's id filter, which treats a partial id as a PREFIX
 * (`id::text LIKE 'x%'`): a free-form `ids: ['']` would update EVERY pipeline in
 * the org, while the per-row visibility check below (exact `inArray`) matched
 * nothing and so forbade nothing.
 */
const FullUuid = z.string().uuid();
const nonUuidIds = (ids: unknown[]): boolean => ids.some((id) => !FullUuid.safeParse(id).success);

/**
 * Register bulk operation routes for pipelines.
 *
 * Each route owns its full guard chain (auth + orgId, then
 * `requirePermission('pipelines:write')` + `requireFeature('bulk_operations')`)
 * so the parent can mount this router plainly on the shared '/pipelines' prefix
 * without the write-permission / feature guards leaking onto sibling reads.
 */
export function createBulkPipelineRoutes(quotaService: QuotaService): Router {
  const router: Router = Router();

  // Guard chain shared by every bulk write route: authenticate + resolve orgId,
  // then require the write permission and the bulk_operations feature.
  const bulkGuards = [
    ...createAuthenticatedWithOrgRoute(),
    requirePermission('pipelines:write'),
    requireFeature('bulk_operations'),
  ];

  /** POST /pipelines/bulk/create — Create multiple pipelines in one request */
  router.post('/bulk/create', ...bulkGuards, audited('pipeline.create', 'pipeline.update'), proposable, withRoute(async ({ req, res, ctx, orgId, userId }) => {
    const bulk = validateBulkArray<unknown>(req.body?.pipelines, 'pipelines', CoreConstants.MAX_BULK_ITEMS);
    if ('error' in bulk) return sendBadRequest(res, bulk.error, ErrorCode.VALIDATION_ERROR);
    const pipelines = bulk.value;

    ctx.log('INFO', 'Bulk create pipelines', { count: pipelines.length });

    const results: {
      created: number;
      updated: number;
      failed: number;
      items: Array<{ index: number; visibility?: string; id?: string }>;
      errors: Array<{ index: number; error: string }>;
    } = { created: 0, updated: 0, failed: 0, items: [], errors: [] };

    for (let i = 0; i < pipelines.length; i++) {
      const raw = pipelines[i];

      // Per-item schema validation (matches single-create semantics).
      const parsed = PipelineCreateSchema.safeParse(raw);
      if (!parsed.success) {
        results.failed++;
        results.errors.push({ index: i, error: parsed.error.message });
        continue;
      }
      const body = parsed.data;

      // Per-item templates + plugin contracts, before any quota is reserved.
      const rejection = await validatePipelineWrite(body, orgId, req.user?.parentOrganizationId);
      if (rejection) {
        results.failed++;
        results.errors.push({ index: i, error: rejection.message });
        continue;
      }

      const prepared = preparePipelineCreate(req, body);
      if ('error' in prepared) {
        results.failed++;
        results.errors.push({ index: i, error: prepared.error });
        continue;
      }

      // Reserve quota per item — fail-closed under contention, matching
      // single-create. The reservation's minted service token (never the end-user
      // bearer) also authenticates the downstream compliance call.
      const reserved = await withQuotaReservation({
        quotaService, orgId, type: 'pipelines', serviceName: 'pipeline', logWarn: ctx.log.bind(null, 'WARN'),
      }, async (slot) => {
        const outcome = await createOnePipeline(req, body, prepared, {
          orgId, userId, serviceAuth: slot.serviceAuth, auditDetails: { bulk: true },
        });

        if (outcome.status !== 'saved') {
          slot.refund();
          results.failed++;
          results.errors.push({
            index: i,
            error: outcome.status === 'blocked'
              ? `Compliance blocked: ${outcome.violations.map(v => v.message).join('; ')}`
              : outcome.error,
          });
          return;
        }

        if (outcome.inserted) {
          results.created++;
        } else {
          // The upsert UPDATED an existing default (not a net-new pipeline), so
          // the `pipelines` create-quota slot wasn't consumed — give it back, or
          // re-running a bulk create for the same org/project silently burns
          // per-period create quota.
          results.updated++;
          slot.refund();
        }
        results.items.push({ index: i, visibility: prepared.visibility, id: outcome.pipeline.id });
      }, (err) => {
        results.failed++;
        results.errors.push({ index: i, error: errorMessage(err) });
      });
      if (reserved.status === 'denied') {
        const { reservation } = reserved;
        results.failed++;
        // Distinguish "couldn't confirm" (quota service down — retryable) from a real limit.
        results.errors.push({
          index: i,
          error: reservation.unavailable
            ? 'Quota service unavailable — could not confirm the pipelines quota; retry shortly'
            : `Quota exceeded: ${reservation.quota.used}/${reservation.quota.limit}`,
        });
      }
    }

    ctx.log('COMPLETED', 'Bulk create complete', {
      created: results.created,
      updated: results.updated,
      failed: results.failed,
    });

    sendSuccess(res, 201, results);
  }));

  /** POST /pipelines/bulk/delete — Soft-delete multiple pipelines by ID */
  router.post('/bulk/delete', ...bulkGuards, audited('pipeline.delete'), withRoute(async ({ req, res, ctx, orgId, userId }) => {
    const bulk = validateBulkArray<string>(req.body?.ids, 'ids', CoreConstants.MAX_BULK_ITEMS);
    if ('error' in bulk) return sendBadRequest(res, bulk.error, ErrorCode.VALIDATION_ERROR);
    if (nonUuidIds(bulk.value)) return sendBadRequest(res, '"ids" must be full pipeline UUIDs', ErrorCode.VALIDATION_ERROR);
    const ids = bulk.value;

    ctx.log('INFO', 'Bulk delete pipelines', { count: ids.length });

    // Apply the SAME visibility rule as single-row delete, per row: author-only
    // for `private`, any member for `org`, `pipelines:publish` for `public`.
    if (!isSystemAdmin(req)) {
      const matched = await pipelineService.findByIds(ids, orgId);
      const forbidden = matched.filter(
        (p) => checkVisibilityWriteAccess(req, p, userId, 'pipelines:publish') !== 'ok',
      );
      if (forbidden.length > 0) {
        return sendError(
          res,
          403,
          'Bulk delete rejected: you cannot delete one or more of these pipelines',
          ErrorCode.INSUFFICIENT_PERMISSIONS,
          { ids: forbidden.map((p) => p.id) },
        );
      }
    }

    const deleted = await pipelineService.bulkDelete(ids, orgId, userId, {
      isSystemAdmin: isSystemAdmin(req),
      canPublish: userHasPermission(req, 'pipelines:publish'),
    });

    ctx.log('COMPLETED', 'Bulk delete complete', { requested: ids.length, deleted: deleted.length });

    // Best-effort attributed audit per row actually deleted.
    for (const d of deleted) {
      recordAudit({
        action: 'pipeline.delete',
        actorId: actorId({ userId }),
        orgId,
        targetType: 'pipeline',
        targetId: d.id,
        details: { bulk: true },
      });
    }

    sendSuccess(res, 200, { deleted: deleted.length, ids: deleted.map(d => d.id) });
  }));

  /** PUT /pipelines/bulk/update — Update multiple pipelines with the same data */
  router.put('/bulk/update', ...bulkGuards, audited('pipeline.update'), withRoute(async ({ req, res, ctx, orgId, userId }) => {
    const bulk = validateBulkArray<string>(req.body?.ids, 'ids', CoreConstants.MAX_BULK_ITEMS);
    if ('error' in bulk) return sendBadRequest(res, bulk.error, ErrorCode.VALIDATION_ERROR);
    if (nonUuidIds(bulk.value)) return sendBadRequest(res, '"ids" must be full pipeline UUIDs', ErrorCode.VALIDATION_ERROR);
    const ids = bulk.value;

    if (!req.body?.data || typeof req.body.data !== 'object') {
      return sendBadRequest(res, 'Request body must include a "data" object with fields to update', ErrorCode.VALIDATION_ERROR);
    }

    // Schema-validate the shared update payload.
    const parsed = PipelineUpdateSchema.safeParse(req.body.data);
    if (!parsed.success) {
      return sendBadRequest(res, parsed.error.message, ErrorCode.VALIDATION_ERROR);
    }
    const validData = parsed.data;

    // Templates + plugin contracts of the shared payload — one verdict for every row.
    const rejection = await validatePipelineWrite(validData, orgId, req.user?.parentOrganizationId);
    if (rejection) return sendError(res, rejection.status, rejection.message, rejection.code, rejection.details);

    // The shared payload can change the compliance posture of every row (same
    // rule as single update) — then each row must be re-checked against its own
    // existing state, so load the rows once for both that and the visibility gate.
    const complianceRelevant = isComplianceRelevantUpdate(validData);
    const matched = (!isSystemAdmin(req) || complianceRelevant) ? await pipelineService.findByIds(ids, orgId) : [];

    // Same per-row visibility rule as single-row update (see bulk delete above).
    if (!isSystemAdmin(req)) {
      const forbidden = matched.filter(
        (p) => checkVisibilityWriteAccess(req, p, userId, 'pipelines:publish') !== 'ok',
      );
      if (forbidden.length > 0) {
        return sendError(
          res,
          403,
          'Bulk update rejected: you cannot modify one or more of these pipelines',
          ErrorCode.INSUFFICIENT_PERMISSIONS,
          { ids: forbidden.map((p) => p.id) },
        );
      }
    }

    // A default is singular per (project, org). Bulk-setting `isDefault: true`
    // would fan out plain per-row updates, bypassing setDefault()'s clear-others
    // transaction and leaving multiple defaults. Promote a default via the
    // single-pipeline PUT instead. (Bulk-clearing `false` is fine.)
    if (validData.isDefault === true) {
      return sendBadRequest(res, 'Cannot set isDefault=true in bulk; promote a default via PUT /pipelines/:id', ErrorCode.VALIDATION_ERROR);
    }

    // Same column writes as single update (incl. catalog metadata + admin-only
    // ownership); only an explicit `isDefault: false` demotion rides along.
    const updateData: Record<string, unknown> = {
      ...buildPipelineUpdateData(req, validData),
      ...(validData.isDefault === false ? { isDefault: false } : {}),
    };

    ctx.log('INFO', 'Bulk update pipelines', { count: ids.length });

    // updateMany flattens array `id` filters to a single value, so fan out
    // per-ID updates instead. CrudService.update handles its own per-row
    // transaction + lifecycle hook.
    //
    // Use allSettled — NOT Promise.all — so one rejected update() can't discard
    // the isolation of the rest: earlier rows may already have committed, and a
    // single throw under Promise.all would surface a blanket 500 that hides
    // them. Instead accumulate per-index errors like bulk/create does.
    //
    // Compliance (fail-closed, per row — mirrors bulk create): a row the payload
    // would make non-compliant, or that can't be checked because compliance is
    // down, is reported in errors[] and NOT updated. A row absent from `matched`
    // isn't visible to the caller, so the update couldn't touch it either — it is
    // skipped rather than written unchecked.
    const matchedById = new Map(matched.map((p) => [p.id, p]));
    const settled = await Promise.allSettled(
      ids.map(async (id) => {
        if (complianceRelevant) {
          const existing = matchedById.get(id);
          if (!existing) return null;
          const verdict = await checkPipelineUpdateCompliance(orgId, existing, updateData);
          if (verdict.status === 'blocked') {
            throw new Error(`Compliance blocked: ${verdict.violations.map((v) => v.message).join('; ')}`);
          }
          if (verdict.status === 'unavailable') {
            throw new Error('Compliance service unavailable — pipeline update rejected');
          }
        }
        return pipelineService.update(id, updateData as PipelineUpdate, orgId, userId);
      }),
    );

    const updatedRows: Array<NonNullable<Awaited<ReturnType<typeof pipelineService.update>>>> = [];
    const errors: Array<{ index: number; error: string }> = [];
    settled.forEach((outcome, i) => {
      if (outcome.status === 'fulfilled') {
        // A null result means the row didn't match (already deleted / wrong
        // org) — not an error, just nothing updated.
        if (outcome.value) updatedRows.push(outcome.value);
      } else {
        errors.push({ index: i, error: errorMessage(outcome.reason) });
      }
    });
    const updatedCount = updatedRows.length;

    ctx.log('COMPLETED', 'Bulk update complete', {
      requested: ids.length,
      updated: updatedCount,
      failed: errors.length,
    });

    // Best-effort attributed audit per row actually updated.
    for (const u of updatedRows) {
      recordAudit({
        action: 'pipeline.update',
        actorId: actorId({ userId }),
        orgId,
        targetType: 'pipeline',
        targetId: u.id,
        details: { fields: Object.keys(updateData), bulk: true },
      });
    }

    sendSuccess(res, 200, { updated: updatedCount, failed: errors.length, errors });
  }));

  return router;
}
