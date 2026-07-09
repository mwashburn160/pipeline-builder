// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import {
  sendBadRequest,
  sendError,
  sendSuccess,
  ErrorCode,
  errorMessage,
  resolveAccessModifier,
  reserveQuota,
  decrementQuota,
  validateBulkArray,
  PipelineCreateSchema,
  PipelineUpdateSchema,
  pickDefined,
  isSystemAdmin,
  createComplianceClient,
  AccessModifier,
} from '@pipeline-builder/api-core';
import type { QuotaService } from '@pipeline-builder/api-core';
import { withRoute } from '@pipeline-builder/api-server';
import { CoreConstants, replaceNonAlphanumeric } from '@pipeline-builder/pipeline-core';
import { Router } from 'express';
import { validatePipelineTemplates, type PipelineLike } from '../helpers/pipeline-template-validator.js';
import { pipelineService, type PipelineInsert, type PipelineUpdate } from '../services/pipeline-service.js';

const complianceClient = createComplianceClient();

/**
 * Register bulk operation routes for pipelines.
 * Requires auth + orgId middleware applied at the parent level.
 */
export function createBulkPipelineRoutes(quotaService: QuotaService): Router {
  const router: Router = Router();

  /** POST /pipelines/bulk/create — Create multiple pipelines in one request */
  router.post('/bulk/create', withRoute(async ({ req, res, ctx, orgId, userId }) => {
    const bulk = validateBulkArray<unknown>(req.body?.pipelines, 'pipelines', CoreConstants.MAX_BULK_ITEMS);
    if ('error' in bulk) return sendBadRequest(res, bulk.error, ErrorCode.VALIDATION_ERROR);
    const pipelines = bulk.value;

    ctx.log('INFO', 'Bulk create pipelines', { count: pipelines.length });

    const authHeader = req.headers.authorization || '';
    const results: {
      created: number;
      updated: number;
      failed: number;
      items: Array<{ index: number; accessModifier?: string; id?: string }>;
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

      // Per-item template validation.
      try {
        validatePipelineTemplates(body as unknown as PipelineLike);
      } catch (err) {
        results.failed++;
        results.errors.push({ index: i, error: errorMessage(err) });
        continue;
      }

      const accessModifier = resolveAccessModifier(req, body.accessModifier);
      const project = replaceNonAlphanumeric(body.project, '_').toLowerCase();
      const organization = replaceNonAlphanumeric(body.organization, '_').toLowerCase();

      if (!project.replace(/_/g, '') || !organization.replace(/_/g, '')) {
        results.failed++;
        results.errors.push({ index: i, error: 'Project and organization must contain alphanumeric characters' });
        continue;
      }

      const pipelineName = body.pipelineName ?? `${organization}-${project}-pipeline`;

      // Reserve quota per item — fail-closed under contention, matching single-create.
      const reservation = await reserveQuota(quotaService, orgId, 'pipelines', authHeader);
      if (reservation.exceeded) {
        results.failed++;
        results.errors.push({ index: i, error: `Quota exceeded: ${reservation.quota.used}/${reservation.quota.limit}` });
        continue;
      }

      try {
        // Per-item compliance check (fail-closed).
        const complianceResult = await complianceClient.validatePipeline(orgId, {
          project,
          organization,
          pipelineName,
          props: body.props,
          accessModifier,
        }, authHeader, undefined, pipelineName, 'create');

        if (complianceResult.blocked) {
          decrementQuota(quotaService, orgId, 'pipelines', authHeader, ctx.log.bind(null, 'WARN'), 1, reservation.quota.resetAt);
          results.failed++;
          results.errors.push({ index: i, error: `Compliance blocked: ${complianceResult.violations.map(v => v.message).join('; ')}` });
          continue;
        }

        const { pipeline, inserted } = await pipelineService.createAsDefaultReportInserted(
          {
            orgId,
            project,
            organization,
            pipelineName,
            description: body.description ?? '',
            keywords: body.keywords ?? [],
            props: body.props as unknown as PipelineInsert['props'],
            accessModifier: accessModifier as AccessModifier,
            createdBy: userId || 'system',
          },
          userId || 'system',
          project,
          organization,
        );

        if (inserted) results.created++; else results.updated++;
        results.items.push({ index: i, accessModifier, id: pipeline.id });
      } catch (err) {
        // Roll back the slot we reserved — the action failed.
        decrementQuota(quotaService, orgId, 'pipelines', authHeader, ctx.log.bind(null, 'WARN'), 1, reservation.quota.resetAt);
        results.failed++;
        results.errors.push({ index: i, error: errorMessage(err) });
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
  router.post('/bulk/delete', withRoute(async ({ req, res, ctx, orgId, userId }) => {
    const bulk = validateBulkArray<string>(req.body?.ids, 'ids', CoreConstants.MAX_BULK_ITEMS);
    if ('error' in bulk) return sendBadRequest(res, bulk.error, ErrorCode.VALIDATION_ERROR);
    const ids = bulk.value;

    ctx.log('INFO', 'Bulk delete pipelines', { count: ids.length });

    // Non-sysadmins can only delete private rows. Fetch the matched set first
    // so we can reject the whole request if it would touch a public row the
    // caller isn't allowed to mutate.
    if (!isSystemAdmin(req)) {
      const matched = await Promise.all(ids.map(id => pipelineService.findById(id, orgId)));
      const nonPrivate = matched.filter((p): p is NonNullable<typeof p> => !!p && p.accessModifier !== AccessModifier.PRIVATE);
      if (nonPrivate.length > 0) {
        return sendError(
          res,
          403,
          'Bulk delete rejected: non-private pipelines require system admin',
          ErrorCode.INSUFFICIENT_PERMISSIONS,
          { ids: nonPrivate.map(p => p.id) },
        );
      }
    }

    const deleted = await pipelineService.bulkDelete(ids, orgId, userId);

    ctx.log('COMPLETED', 'Bulk delete complete', { requested: ids.length, deleted: deleted.length });

    sendSuccess(res, 200, { deleted: deleted.length, ids: deleted.map(d => d.id) });
  }));

  /** PUT /pipelines/bulk/update — Update multiple pipelines with the same data */
  router.put('/bulk/update', withRoute(async ({ req, res, ctx, orgId, userId }) => {
    const bulk = validateBulkArray<string>(req.body?.ids, 'ids', CoreConstants.MAX_BULK_ITEMS);
    if ('error' in bulk) return sendBadRequest(res, bulk.error, ErrorCode.VALIDATION_ERROR);
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

    // Templates in shared payload (metadata.*, vars.*, projectName).
    try {
      validatePipelineTemplates(validData as unknown as PipelineLike);
    } catch (err) {
      return sendBadRequest(res, errorMessage(err), ErrorCode.TEMPLATE_VALIDATION_FAILED);
    }

    // Sysadmin guard: if any matched row is non-private, only sysadmins can update.
    if (!isSystemAdmin(req)) {
      const matched = await Promise.all(ids.map(id => pipelineService.findById(id, orgId)));
      const nonPrivate = matched.filter((p): p is NonNullable<typeof p> => !!p && p.accessModifier !== AccessModifier.PRIVATE);
      if (nonPrivate.length > 0) {
        return sendError(
          res,
          403,
          'Bulk update rejected: non-private pipelines require system admin',
          ErrorCode.INSUFFICIENT_PERMISSIONS,
          { ids: nonPrivate.map(p => p.id) },
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

    // Strip undefined and immutable/tenant-shaped fields before fan-out.
    const updateData = pickDefined({
      pipelineName: validData.pipelineName,
      description: validData.description,
      keywords: validData.keywords,
      props: validData.props,
      isActive: validData.isActive,
      isDefault: validData.isDefault,
      ...(validData.accessModifier !== undefined
        ? { accessModifier: resolveAccessModifier(req, validData.accessModifier) }
        : {}),
    });

    ctx.log('INFO', 'Bulk update pipelines', { count: ids.length });

    // updateMany flattens array `id` filters to a single value, so fan out
    // per-ID updates instead. CrudService.update handles its own per-row
    // transaction + lifecycle hook.
    const updates = await Promise.all(
      ids.map(id => pipelineService.update(id, updateData as PipelineUpdate, orgId, userId)),
    );
    const updatedCount = updates.filter(u => u !== null).length;

    ctx.log('COMPLETED', 'Bulk update complete', { requested: ids.length, updated: updatedCount });

    sendSuccess(res, 200, { updated: updatedCount });
  }));

  return router;
}
