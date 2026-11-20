// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The pipeline page's view of nightly CVE remediation (Stage 3): its "plugin
 * security fixes" election, the effective mode, and every proposal, wave move
 * and rollback of the pipeline (`pipeline_remediation_upgrades`).
 *
 * - GET  /:id/remediation-upgrades                       — pipelines:read
 * - POST /:id/remediation-upgrades/:upgradeId/apply      — pipelines:write; a `proposed`
 *   row through the plugin-upgrades apply path (actor = the user), audited
 *   `pipeline.plugin.upgraded`
 * - POST /:id/remediation-upgrades/:upgradeId/dismiss    — pipelines:write; `proposed` →
 *   `dismissed` (UI state, not audited)
 *
 * Each route owns its auth chain (mounted with the other self-guarded routers);
 * apiCalls is metered + checked by the '/pipelines' prefix mount in app-routes.ts.
 */

import {
  audited,
  ErrorCode,
  getParam,
  requirePermission,
  requireVisibilityWriteAccess,
  sendBadRequest,
  sendEntityNotFound,
  sendError,
  sendSuccess,
  userHasPermission,
  type PipelineRemediationElection,
} from '@pipeline-builder/api-core';
import { createAuthenticatedWithOrgRoute, withRoute } from '@pipeline-builder/api-server';
import { runWithTenantContext, withTenantTx } from '@pipeline-builder/pipeline-data';
import { sql } from 'drizzle-orm';
import { Router } from 'express';
import { loadPipelineRows, patchRow, rolloutEngine, type RolloutEngine, type UpgradeRow } from '../helpers/remediation-rollout.js';
import { effectiveRollout, readOrgRolloutSettings, remediationEnabled } from '../helpers/remediation-settings.js';
import { pipelineService, type Pipeline } from '../services/pipeline-service.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** What the fix a row proposes clears (from the plugin service's remediation record). */
export interface RemediationAdvisories {
  advisoryIds: string[];
  criticalCleared: number;
  highCleared: number;
  kev: boolean;
}

/** One row as the page reads it (dates ISO). */
export function upgradeDto(row: UpgradeRow, advisories?: RemediationAdvisories) {
  const iso = (d: Date | null) => (d ? d.toISOString() : null);
  return {
    id: row.id,
    orgId: row.orgId,
    remediationId: row.remediationId,
    pipelineId: row.pipelineId,
    pluginName: row.pluginName,
    pluginPublisher: row.pluginPublisher,
    fromVersion: row.fromVersion,
    toVersion: row.toVersion,
    mode: row.mode,
    state: row.state,
    wave: row.wave,
    movedAt: iso(row.movedAt),
    runRequestId: row.runRequestId,
    rolledBackAt: iso(row.rolledBackAt),
    rolledBackTo: row.rolledBackTo,
    error: row.error,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
    advisories: advisories ?? { advisoryIds: [], criticalCleared: 0, highCleared: 0, kev: false },
  };
}

/**
 * The advisories each remediation's fix clears, read from `plugin_remediations`
 * (its `cleared` ids, graded by its `targeted` findings). Sysadmin-scoped by
 * the explicit ids: an Official fix's remediation is the system org's row.
 */
export async function remediationAdvisories(ids: readonly string[]): Promise<Map<string, RemediationAdvisories>> {
  const out = new Map<string, RemediationAdvisories>();
  const unique = [...new Set(ids)].filter((id) => UUID.test(id));
  if (unique.length === 0) return out;
  const res = await runWithTenantContext({ isSuperAdmin: true }, () => withTenantTx((tx) => tx.execute(sql`
    SELECT id::text AS id, cleared, targeted FROM plugin_remediations
    WHERE id IN (${sql.join(unique.map((id) => sql`${id}::uuid`), sql`, `)})`)));
  const rows = (Array.isArray(res) ? res : ((res as { rows?: unknown[] }).rows ?? [])) as Array<{ id: string; cleared: unknown; targeted: unknown }>;
  for (const r of rows) {
    const cleared = Array.isArray(r.cleared) ? r.cleared as Array<{ id?: unknown }> : [];
    const targeted = Array.isArray(r.targeted) ? r.targeted as Array<{ id?: unknown; severity?: unknown; kev?: unknown }> : [];
    const ids2 = [...new Set(cleared.map((c) => (typeof c.id === 'string' ? c.id : null)).filter((x): x is string => !!x))];
    const grade = new Map(targeted.filter((t) => typeof t.id === 'string').map((t) => [t.id as string, t]));
    out.set(r.id, {
      advisoryIds: ids2,
      criticalCleared: ids2.filter((id) => grade.get(id)?.severity === 'critical').length,
      highCleared: ids2.filter((id) => grade.get(id)?.severity === 'high').length,
      kev: ids2.some((id) => grade.get(id)?.kev === true),
    });
  }
  return out;
}

export function createRemediationUpgradeRoutes(engine: () => RolloutEngine = rolloutEngine): Router {
  const router = Router();

  /** The caller's own pipeline (the rows are org-scoped: a parent's shared pipeline is not the caller's to move). */
  const ownPipeline = async (id: string, orgId: string): Promise<Pipeline | null> => {
    const p = await pipelineService.findById(id, orgId) as Pipeline | null;
    return p && p.orgId.toLowerCase() === orgId.toLowerCase() ? p : null;
  };

  /** The pipeline's row `upgradeId`, or null. */
  const rowOf = async (pipeline: Pipeline, upgradeId: string): Promise<UpgradeRow | null> => {
    if (!UUID.test(upgradeId)) return null;
    const rows = await loadPipelineRows(pipeline.id);
    return rows.find((r) => r.id.toLowerCase() === upgradeId.toLowerCase() && r.orgId.toLowerCase() === pipeline.orgId.toLowerCase()) ?? null;
  };

  router.get('/:id/remediation-upgrades',
    ...createAuthenticatedWithOrgRoute(), requirePermission('pipelines:read'),
    withRoute(async ({ req, res, ctx, orgId }) => {
      const id = getParam(req.params, 'id');
      if (!id || !UUID.test(id)) return sendBadRequest(res, 'A pipeline id is required.', ErrorCode.VALIDATION_ERROR);
      const pipeline = await ownPipeline(id, orgId);
      if (!pipeline) return sendEntityNotFound(res, 'Pipeline');
      const settings = await readOrgRolloutSettings(orgId, req.user?.parentOrganizationId ?? null);
      const election = (pipeline.remediationUpgrades ?? 'inherit') as PipelineRemediationElection;
      const rows = (await loadPipelineRows(pipeline.id)).filter((r) => r.orgId.toLowerCase() === pipeline.orgId.toLowerCase());
      const advisories = await remediationAdvisories(rows.map((r) => r.remediationId));
      ctx.log('COMPLETED', 'Read remediation upgrades', { id: pipeline.id, upgrades: rows.length });
      return sendSuccess(res, 200, {
        enabled: remediationEnabled(),
        election,
        effective: effectiveRollout(election, settings),
        orgDefault: settings.orgDefault,
        allowPipelineApply: settings.allowPipelineApply,
        upgrades: rows.map((r) => upgradeDto(r, advisories.get(r.remediationId))),
      });
    }));

  router.post('/:id/remediation-upgrades/:upgradeId/apply',
    ...createAuthenticatedWithOrgRoute(), requirePermission('pipelines:write'), audited('pipeline.plugin.upgraded'),
    withRoute(async ({ req, res, ctx, orgId, userId }) => {
      const id = getParam(req.params, 'id');
      const upgradeId = getParam(req.params, 'upgradeId');
      if (!id || !UUID.test(id) || !upgradeId) return sendBadRequest(res, 'A pipeline id and an upgrade id are required.', ErrorCode.VALIDATION_ERROR);
      const pipeline = await ownPipeline(id, orgId);
      if (!pipeline) return sendEntityNotFound(res, 'Pipeline');
      // The same per-row visibility ladder as a PUT (author-only private, publish for public).
      if (!requireVisibilityWriteAccess(req, res, pipeline, userId, 'pipelines:publish')) return;
      const row = await rowOf(pipeline, upgradeId);
      if (!row) return sendEntityNotFound(res, 'Remediation upgrade');
      if (row.state !== 'proposed') {
        return sendError(res, 409, `This upgrade is ${row.state.replace(/_/g, ' ')}, not proposed.`, ErrorCode.REMEDIATION_STAGE_CONFLICT, { stage: row.state });
      }
      const parentOrgId = req.user?.parentOrganizationId ?? null;
      const result = await engine().applyProposal(row, {
        id: pipeline.id,
        orgId: pipeline.orgId,
        props: pipeline.props,
        pipelineName: pipeline.pipelineName,
        remediationUpgrades: (pipeline.remediationUpgrades ?? 'inherit') as PipelineRemediationElection,
      }, { userId, requestedBy: userId }, parentOrgId, { moveInstall: userHasPermission(req, 'plugins:install') });
      if (!result.ok) {
        ctx.log('WARN', 'Remediation proposal not applied', { id: pipeline.id, upgradeId: row.id, error: result.error });
        return sendError(res, 409, `The upgrade could not be applied: ${result.error}`, ErrorCode.CONFLICT);
      }
      const updated = (await loadPipelineRows(pipeline.id)).find((r) => r.id === row.id) ?? row;
      ctx.log('COMPLETED', 'Applied remediation proposal', { id: pipeline.id, upgradeId: row.id });
      return sendSuccess(res, 200, { upgrade: upgradeDto(updated) });
    }));

  router.post('/:id/remediation-upgrades/:upgradeId/dismiss',
    ...createAuthenticatedWithOrgRoute(), requirePermission('pipelines:write'),
    withRoute(async ({ req, res, ctx, orgId, userId }) => {
      const id = getParam(req.params, 'id');
      const upgradeId = getParam(req.params, 'upgradeId');
      if (!id || !UUID.test(id) || !upgradeId) return sendBadRequest(res, 'A pipeline id and an upgrade id are required.', ErrorCode.VALIDATION_ERROR);
      const pipeline = await ownPipeline(id, orgId);
      if (!pipeline) return sendEntityNotFound(res, 'Pipeline');
      if (!requireVisibilityWriteAccess(req, res, pipeline, userId, 'pipelines:publish')) return;
      const row = await rowOf(pipeline, upgradeId);
      if (!row) return sendEntityNotFound(res, 'Remediation upgrade');
      if (!await patchRow(row.id, { state: 'dismissed' }, ['proposed'])) {
        return sendError(res, 409, `This upgrade is ${row.state.replace(/_/g, ' ')}, not proposed.`, ErrorCode.REMEDIATION_STAGE_CONFLICT, { stage: row.state });
      }
      ctx.log('COMPLETED', 'Dismissed remediation proposal', { id: pipeline.id, upgradeId: row.id });
      return sendSuccess(res, 200, { upgrade: upgradeDto({ ...row, state: 'dismissed' }) });
    }));

  return router;
}
