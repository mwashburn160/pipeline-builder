// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from 'node:crypto';
import {
  actorId,
  audited,
  checkVisibilityWriteAccess,
  ErrorCode,
  errorMessage,
  getParam,
  recordAudit,
  requirePermission,
  sendBadRequest,
  sendEntityNotFound,
  sendSuccess,
  validateBody,
} from '@pipeline-builder/api-core';
import { createAuthenticatedWithOrgRoute, withRoute } from '@pipeline-builder/api-server';
import { pipelinesOnVersion } from '@pipeline-builder/pipeline-data';
import { Router } from 'express';
import { z } from 'zod';
import { checkPipelineUpdateCompliance } from '../helpers/pipeline-update-compliance.js';
import { complianceBlockedDetails, validatePipelineWrite } from '../helpers/pipeline-write.js';
import { recordPipelineResolution } from '../helpers/plugin-contract-check.js';
import type { PluginWarning } from '../helpers/plugin-save-check.js';
import { applyPluginUpgrades, previewPluginUpgrades, type AppliedUpgrade, type StepUpgrade } from '../helpers/plugin-upgrades.js';
import { pipelineExecutionService } from '../services/pipeline-execution-service.js';
import { pipelineService, type Pipeline } from '../services/pipeline-service.js';

/** Upper bound on pipelines per apply (each is a full validated write). */
const MAX_APPLY_PIPELINES = 50;

const ApplySchema = z.object({
  pipelineIds: z.array(z.string().uuid()).min(1).max(MAX_APPLY_PIPELINES),
  /** Re-anchor ranges / cross a pin when nothing inside it is clean (see plugin-upgrades.ts). */
  widen: z.boolean().optional(),
  /** Only these step keys (`synth`, `<stage>/<step>`); all upgradable steps when omitted. */
  steps: z.array(z.string().min(1).max(255)).max(200).optional(),
  /** Start an execution of each upgraded, registered pipeline — its synth re-reads the new config. */
  redeploy: z.boolean().optional(),
});

/** One version an upgrade moves off, and whether anything still references it. */
interface VersionRelease {
  plugin: string;
  publisher: string | null;
  version: string;
  /** The org's pipelines still referencing it, by source. */
  references: { declared: number; deployed: number };
  /**
   * Nothing in the org declares or runs it any more, so the plugin's removal
   * guard no longer holds it. A DEPLOYED reference clears only when the
   * pipeline is redeployed (and re-registers its manifest).
   */
  removable: boolean;
}

/**
 * Where each version `moves` leaves stands: how many of the org's pipelines
 * still declare / run it, ignoring the DECLARED references of `excludeDeclared`
 * (the preview's "after this apply" view). Read under the caller's tenant
 * scope, so "removable" is the org's view; a listed version other orgs run is
 * still guarded by theirs.
 */
async function versionReleases(
  moves: ReadonlyArray<Pick<AppliedUpgrade, 'plugin' | 'publisher' | 'fromVersion'>>,
  excludeDeclared: ReadonlySet<string> = new Set(),
): Promise<VersionRelease[]> {
  const seen = new Map<string, Pick<AppliedUpgrade, 'plugin' | 'publisher' | 'fromVersion'>>();
  for (const m of moves) seen.set(`${m.plugin}@${m.fromVersion}`, m);
  const out: VersionRelease[] = [];
  for (const m of seen.values()) {
    const name = m.publisher ? m.plugin.slice(m.publisher.length + 1) : m.plugin;
    const refs = await pipelinesOnVersion({ pluginName: name, pluginVersion: m.fromVersion, pluginPublisher: m.publisher });
    const declared = refs.filter((r) => r.source === 'declared' && !excludeDeclared.has(r.pipelineId)).length;
    const deployed = refs.filter((r) => r.source === 'deployed').length;
    out.push({ plugin: m.plugin, publisher: m.publisher, version: m.fromVersion, references: { declared, deployed }, removable: declared === 0 && deployed === 0 });
  }
  return out;
}

/** The steps preview would rewrite, as `moves` for {@link versionReleases}. */
function previewMoves(upgrades: readonly StepUpgrade[], widen: boolean) {
  return upgrades
    .filter((u) => (widen ? u.apply.widenVersion : u.apply.version) !== null)
    .map((u) => ({ plugin: u.plugin, publisher: u.publisher, fromVersion: u.currentVersion }));
}

/** Per-pipeline apply outcome. */
type ApplyOutcome =
  | { pipelineId: string; status: 'upgraded'; applied: AppliedUpgrade[]; pluginWarnings?: PluginWarning[]; redeploy?: { executionId: string } | { error: string } }
  | { pipelineId: string; status: 'unchanged' }
  | { pipelineId: string; status: 'failed'; error: string };

/**
 * Plugin-version remediation for pipelines (see helpers/plugin-upgrades.ts).
 *
 * - POST /:id/plugin-upgrades/preview — `pipelines:read`; writes nothing. Each
 *   step that needs an upgrade, its suggestions, and which versions the apply
 *   would leave unreferenced (`releases`).
 * - POST /plugin-upgrades/apply — `pipelines:write`; rewrites the steps' version
 *   pins across up to 50 pipelines, each through the normal write path (template
 *   validation, plugin contract check, compliance re-check, resolution recording),
 *   audited `pipeline.plugin.upgraded` per pipeline. With `redeploy`, starts an
 *   execution of each upgraded registered pipeline (its synth reads the new config);
 *   otherwise each upgraded pipeline reports `redeployRequired`.
 *
 * Each route owns its auth chain (mounted with the other self-guarded routers);
 * apiCalls is metered + checked by the '/pipelines' prefix mount in app-routes.ts.
 */
export function createPluginUpgradeRoutes(): Router {
  const router = Router();

  router.post('/:id/plugin-upgrades/preview',
    ...createAuthenticatedWithOrgRoute(), requirePermission('pipelines:read'),
    withRoute(async ({ req, res, ctx, orgId }) => {
      const id = getParam(req.params, 'id');
      if (!id) return sendBadRequest(res, 'Pipeline id is required.', ErrorCode.MISSING_REQUIRED_FIELD);
      const pipeline = await pipelineService.findById(id, orgId);
      if (!pipeline) return sendEntityNotFound(res, 'Pipeline');

      const widen = req.query.widen === 'true';
      const upgrades = await previewPluginUpgrades(pipeline.props, orgId, req.user?.parentOrganizationId);
      const releases = await versionReleases(previewMoves(upgrades, widen), new Set([id]));
      ctx.log('COMPLETED', 'Previewed plugin upgrades', { id, steps: upgrades.length });
      return sendSuccess(res, 200, { pipelineId: id, upgrades, releases });
    }));

  router.post('/plugin-upgrades/apply',
    ...createAuthenticatedWithOrgRoute(), requirePermission('pipelines:write'), audited('pipeline.plugin.upgraded'),
    withRoute(async ({ req, res, ctx, orgId, userId }) => {
      const validation = validateBody(req, ApplySchema);
      if (!validation.ok) return sendBadRequest(res, validation.error, ErrorCode.VALIDATION_ERROR);
      const { pipelineIds, widen = false, steps, redeploy = false } = validation.value;
      const parentOrgId = req.user?.parentOrganizationId;

      const results: ApplyOutcome[] = [];
      const moved: AppliedUpgrade[] = [];
      // One id shared by every per-pipeline audit event of this apply, so a
      // reviewer can regroup the fan-out (each event names its own pipeline).
      const batchId = randomUUID();
      for (const id of [...new Set(pipelineIds)]) {
        try {
          const existing = await pipelineService.findById(id, orgId) as Pipeline | null;
          if (!existing) { results.push({ pipelineId: id, status: 'failed', error: 'Pipeline not found' }); continue; }
          // The same per-row visibility ladder as a PUT (author-only private, publish for public).
          if (checkVisibilityWriteAccess(req, existing, userId, 'pipelines:publish') !== 'ok') {
            results.push({ pipelineId: id, status: 'failed', error: 'You cannot modify this pipeline' });
            continue;
          }

          const upgrades = await previewPluginUpgrades(existing.props, orgId, parentOrgId);
          const { props, applied } = applyPluginUpgrades(existing.props, upgrades, { widen, ...(steps ? { onlySteps: steps } : {}) });
          if (applied.length === 0) { results.push({ pipelineId: id, status: 'unchanged' }); continue; }

          // The normal write path: templates + plugin contracts, then compliance (fail-closed).
          const check = await validatePipelineWrite({ props } as never, orgId, parentOrgId, id, existing);
          if (check.rejection) { results.push({ pipelineId: id, status: 'failed', error: check.rejection.message }); continue; }
          const verdict = await checkPipelineUpdateCompliance(orgId, existing, { props });
          if (verdict.status === 'blocked') {
            recordAudit({
              action: 'pipeline.plugin.upgraded',
              actorId: actorId({ userId }),
              orgId,
              targetType: 'pipeline',
              targetId: id,
              outcome: 'failure',
              details: { pipelineName: existing.pipelineName, widen, changes: applied, redeploy, batchId, ...complianceBlockedDetails(verdict.violations) },
            });
            results.push({ pipelineId: id, status: 'failed', error: `Compliance blocked: ${verdict.violations.map((v) => v.message).join('; ')}` });
            continue;
          }
          if (verdict.status === 'unavailable') {
            results.push({ pipelineId: id, status: 'failed', error: 'Compliance service unavailable — pipeline update rejected' });
            continue;
          }

          const updated = await pipelineService.update(id, { props } as never, orgId, userId);
          if (!updated) { results.push({ pipelineId: id, status: 'failed', error: 'Pipeline not found' }); continue; }
          // Awaited: the moved-off versions' references are gone before the response
          // (and before any plugin delete that follows it).
          await recordPipelineResolution(id, orgId, parentOrgId, updated.props);
          moved.push(...applied);

          recordAudit({
            action: 'pipeline.plugin.upgraded',
            actorId: actorId({ userId }),
            orgId,
            targetType: 'pipeline',
            targetId: id,
            details: { pipelineName: updated.pipelineName, widen, changes: applied, redeploy, batchId },
          });

          let redeployOutcome: { executionId: string } | { error: string } | undefined;
          if (redeploy) {
            try {
              redeployOutcome = await pipelineExecutionService.triggerExecution(id, orgId);
              recordAudit({
                action: 'pipeline.execution.start',
                actorId: actorId({ userId }),
                orgId,
                targetType: 'pipeline_execution',
                targetId: redeployOutcome.executionId,
                details: { pipelineId: id, reason: 'plugin-upgrade', batchId },
              });
            } catch (err) {
              redeployOutcome = { error: errorMessage(err) };
              recordAudit({
                action: 'pipeline.execution.start',
                actorId: actorId({ userId }),
                orgId,
                targetType: 'pipeline_execution',
                outcome: 'failure',
                details: { pipelineId: id, reason: 'plugin-upgrade', batchId },
              });
            }
          }
          results.push({
            pipelineId: id,
            status: 'upgraded',
            applied,
            ...(check.pluginWarnings.length > 0 ? { pluginWarnings: check.pluginWarnings } : {}),
            ...(redeployOutcome ? { redeploy: redeployOutcome } : {}),
          });
        } catch (err) {
          results.push({ pipelineId: id, status: 'failed', error: errorMessage(err) });
        }
      }

      const upgraded = results.filter((r) => r.status === 'upgraded');
      const releases = await versionReleases(moved);
      ctx.log('COMPLETED', 'Applied plugin upgrades', {
        requested: pipelineIds.length, upgraded: upgraded.length, failed: results.filter((r) => r.status === 'failed').length,
      });
      return sendSuccess(res, 200, {
        upgraded: upgraded.length,
        results,
        releases,
        // Nothing runs the new versions until a synth re-reads the config.
        redeployRequired: !redeploy && upgraded.length > 0,
      });
    }));

  return router;
}
