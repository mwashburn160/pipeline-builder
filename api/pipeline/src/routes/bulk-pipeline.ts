// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import {
  sendBadRequest,
  sendError,
  sendSuccess,
  ErrorCode,
  errorMessage,
  resolveVisibility,
  reserveQuota,
  decrementQuota,
  getServiceAuthHeader,
  requireFeature,
  requirePermission,
  validateBulkArray,
  PipelineCreateSchema,
  PipelineUpdateSchema,
  pickDefined,
  isSystemAdmin,
  checkVisibilityWriteAccess,
  userHasPermission,
  createComplianceClient,
  audited,
  actorId,
} from '@pipeline-builder/api-core';
import type { QuotaService } from '@pipeline-builder/api-core';
import { createAuthenticatedWithOrgRoute, withRoute } from '@pipeline-builder/api-server';
import { CoreConstants, replaceNonAlphanumeric } from '@pipeline-builder/pipeline-core';
import { Router } from 'express';
import { z } from 'zod';
import { validatePipelineTemplates } from '../helpers/pipeline-template-validator.js';
import { checkPipelineUpdateCompliance, isComplianceRelevantUpdate } from '../helpers/pipeline-update-compliance.js';
import { findPluginContractViolations, formatContractViolations } from '../helpers/plugin-contract-check.js';
import { emitPipelineAudit } from '../services/audit.js';
import { pipelineService, type PipelineInsert, type PipelineUpdate } from '../services/pipeline-service.js';

const complianceClient = createComplianceClient();

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
  router.post('/bulk/create', ...bulkGuards, audited('pipeline.create', 'pipeline.update'), withRoute(async ({ req, res, ctx, orgId, userId }) => {
    const bulk = validateBulkArray<unknown>(req.body?.pipelines, 'pipelines', CoreConstants.MAX_BULK_ITEMS);
    if ('error' in bulk) return sendBadRequest(res, bulk.error, ErrorCode.VALIDATION_ERROR);
    const pipelines = bulk.value;

    ctx.log('INFO', 'Bulk create pipelines', { count: pipelines.length });

    // Mint a service token for the downstream S2S calls (quota, compliance)
    // rather than forwarding the end-user bearer — the caller's token may carry
    // only end-user scopes that service-to-service authorization rejects,
    // failing legitimate creates. Mirrors upload-plugin.ts / create-pipeline.ts.
    const authHeader = getServiceAuthHeader({ serviceName: 'pipeline', orgId, role: 'member' });
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

      // Per-item template validation.
      try {
        validatePipelineTemplates(body);
      } catch (err) {
        results.failed++;
        results.errors.push({ index: i, error: errorMessage(err) });
        continue;
      }

      // Per-item plugin contracts (W0.2), before any quota is reserved.
      const contractViolations = await findPluginContractViolations(body.props, orgId, req.user?.parentOrganizationId);
      if (contractViolations.length > 0) {
        results.failed++;
        results.errors.push({ index: i, error: formatContractViolations(contractViolations) });
        continue;
      }

      const visibility = resolveVisibility(req, body.visibility, 'pipelines:publish', 'org');
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
        // Distinguish "couldn't confirm" (quota service down — retryable) from a real limit.
        results.errors.push({
          index: i,
          error: reservation.unavailable
            ? 'Quota service unavailable — could not confirm the pipelines quota; retry shortly'
            : `Quota exceeded: ${reservation.quota.used}/${reservation.quota.limit}`,
        });
        continue;
      }

      try {
        // Per-item compliance check (fail-closed).
        const complianceResult = await complianceClient.validatePipeline(orgId, {
          project,
          organization,
          pipelineName,
          props: body.props,
          visibility,
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
            visibility: visibility,
            createdBy: userId || 'system',
            // Catalog ownership: default to the creator so bulk-imported
            // pipelines also appear under "my services".
            ownerId: userId || 'system',
            ownerType: 'user',
          },
          userId || 'system',
          project,
          organization,
          // Same overwrite gate as single create (visibility ladder + no tombstone revival).
          { isSystemAdmin: isSystemAdmin(req), canPublish: userHasPermission(req, 'pipelines:publish') },
        );

        if (inserted) {
          results.created++;
        } else {
          // The upsert UPDATED an existing default (not a net-new pipeline), so
          // the `pipelines` create-quota slot reserved above wasn't actually
          // consumed — give it back. Without this, re-running a bulk create for
          // the same org/project silently burns per-period create quota for
          // pipelines that already existed.
          results.updated++;
          decrementQuota(quotaService, orgId, 'pipelines', authHeader, ctx.log.bind(null, 'WARN'), 1, reservation.quota.resetAt);
        }
        results.items.push({ index: i, visibility, id: pipeline.id });

        // Best-effort attributed audit per successful item — emitted only
        // after the row landed. `inserted` distinguishes create vs. upsert.
        emitPipelineAudit({
          action: inserted ? 'pipeline.create' : 'pipeline.update',
          actorId: actorId({ userId }),
          orgId,
          targetType: 'pipeline',
          targetId: pipeline.id,
          details: {
            project,
            organization,
            pipelineName,
            visibility,
            bulk: true,
          },
        });
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
  router.post('/bulk/delete', ...bulkGuards, audited('pipeline.delete'), withRoute(async ({ req, res, ctx, orgId, userId }) => {
    const bulk = validateBulkArray<string>(req.body?.ids, 'ids', CoreConstants.MAX_BULK_ITEMS);
    if ('error' in bulk) return sendBadRequest(res, bulk.error, ErrorCode.VALIDATION_ERROR);
    if (nonUuidIds(bulk.value)) return sendBadRequest(res, '"ids" must be full pipeline UUIDs', ErrorCode.VALIDATION_ERROR);
    const ids = bulk.value;

    ctx.log('INFO', 'Bulk delete pipelines', { count: ids.length });

    // Apply the SAME visibility rule as single-row delete, per row: author-only
    // for `private`, any member for `org`, `pipelines:publish` for `public`.
    // This previously rejected anything not `private`, which made bulk delete
    // unusable for the DEFAULT rung (`org`) that single delete allows.
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
      emitPipelineAudit({
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

    // Templates in shared payload (metadata.*, vars.*, project).
    try {
      validatePipelineTemplates(validData);
    } catch (err) {
      return sendBadRequest(res, errorMessage(err), ErrorCode.TEMPLATE_VALIDATION_FAILED);
    }

    // Plugin contracts (W0.2) of the shared props — one verdict for every row.
    if (validData.props) {
      const contractViolations = await findPluginContractViolations(validData.props, orgId, req.user?.parentOrganizationId);
      if (contractViolations.length > 0) {
        return sendError(res, 400, formatContractViolations(contractViolations), ErrorCode.TEMPLATE_CONTRACT_VIOLATION, { steps: contractViolations });
      }
    }

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

    // Strip undefined and immutable/tenant-shaped fields before fan-out.
    const updateData = pickDefined({
      pipelineName: validData.pipelineName,
      description: validData.description,
      keywords: validData.keywords,
      props: validData.props,
      isActive: validData.isActive,
      isDefault: validData.isDefault,
      ...(validData.visibility !== undefined
        ? { visibility: resolveVisibility(req, validData.visibility, 'pipelines:publish') }
        : {}),
    });

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
      emitPipelineAudit({
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
