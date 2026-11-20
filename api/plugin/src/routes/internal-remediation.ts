// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * POST /internal/plugins/remediations/:remediationId/rollout — the pipeline
 * service's progress report on a remediation rollout (api-core
 * PLUGIN_INTERNAL.reportRemediationRollout; callers: pipeline). Mounted under
 * `/internal` after `requireAuth`.
 *
 * Stores the summary in `plugin_remediations.rollout`, moves the stage
 * (published → rolling_out; `done` → done; `paused` → needs_review) and sends
 * N37 when the rollout finishes or pauses (once per transition) and N38 per
 * new rolled_back / rollback_blocked event. Idempotent per (remediationId,
 * pipelineId, kind, at): a redelivered report notifies nobody twice. 404 for an
 * unknown remediation.
 */

import {
  contractErrorMessage,
  contractRoute,
  createLogger,
  ErrorCode,
  errorMessage,
  parseContractBody,
  parseContractParams,
  PLUGIN_INTERNAL,
  requireInternalService,
  sendBadRequest,
  sendError,
  sendSuccess,
  type RemediationRolloutSummary,
} from '@pipeline-builder/api-core';
import type { PluginRemediation } from '@pipeline-builder/pipeline-data';
import { Router, type RequestHandler } from 'express';

import { countStage } from '../services/remediation/lifecycle.js';
import { getRemediation, updateRemediation } from '../services/remediation/store.js';
import { sendRemediationNotice } from '../services/remediation-notices.js';

const C = PLUGIN_INTERNAL.reportRemediationRollout;
const MOUNT = '/internal';
const logger = createLogger('plugin-remediation-report');

/** Event keys kept on the row for redelivery dedupe (bounded). */
const MAX_EVENT_KEYS = 2_000;

/** What the row's `rollout` jsonb carries beyond the summary (dedupe + the card's rollback list). */
type StoredRollout = RemediationRolloutSummary & { eventKeys?: string[]; rolledBackPipelineIds?: string[] };

export interface RolloutReport {
  summary: RemediationRolloutSummary;
  events: Array<{ kind: 'rolled_back' | 'rollback_blocked'; orgId: string; pipelineId: string; fromVersion: string; toVersion: string; at: string }>;
}

/** Apply one report to its remediation (exported for tests). Null = unknown remediation. */
export async function applyRolloutReport(remediationId: string, report: RolloutReport): Promise<PluginRemediation | null> {
  const row = await getRemediation(remediationId);
  if (!row) return null;
  const prev = (row.rollout ?? null) as StoredRollout | null;
  const seen = new Set(prev?.eventKeys ?? []);
  const fresh = report.events.filter((e) => !seen.has(`${e.pipelineId}|${e.kind}|${e.at}`));
  for (const e of fresh) seen.add(`${e.pipelineId}|${e.kind}|${e.at}`);
  const rolledBack = new Set(prev?.rolledBackPipelineIds ?? []);
  for (const e of fresh) if (e.kind === 'rolled_back') rolledBack.add(e.pipelineId);

  const rollout: StoredRollout = { ...report.summary, eventKeys: [...seen].slice(-MAX_EVENT_KEYS), rolledBackPipelineIds: [...rolledBack].slice(0, 1_000) };
  const status = report.summary.status;
  const live = row.stage === 'published' || row.stage === 'rolling_out' || row.stage === 'needs_review';
  let stage = row.stage;
  if (live && status === 'done') stage = 'done';
  else if (live && status === 'paused') stage = 'needs_review';
  else if (row.stage === 'published' && (status === 'pending' || status === 'canary' || status === 'batches')) stage = 'rolling_out';

  const updated = (await updateRemediation(row.id, {
    rollout: rollout as RemediationRolloutSummary,
    ...(stage !== row.stage ? { stage, ...(stage === 'done' ? { finishedAt: new Date() } : {}) } : {}),
  })) ?? row;
  if (stage !== row.stage) countStage(stage, stage === 'done' ? updated.outcome : null);

  const base = { orgId: row.orgId, remediationId: row.id, pluginName: row.pluginName, fromVersion: row.fromVersion, toVersion: row.toVersion };
  if (stage !== row.stage && (stage === 'done' || stage === 'needs_review')) {
    const affectedOrgIds = [...new Set(report.events.map((e) => e.orgId.toLowerCase()))];
    await sendRemediationNotice({ code: 'N37', ...base, summary: report.summary, ...(affectedOrgIds.length ? { affectedOrgIds } : {}) }).catch((err) => logger.warn('N37 not sent', { remediationId: row.id, error: errorMessage(err) }));
  }
  for (const e of fresh) {
    await sendRemediationNotice({
      code: 'N38',
      ...base,
      pipelineOrgId: e.orgId,
      pipelineId: e.pipelineId,
      kind: e.kind,
      ...(e.kind === 'rolled_back' ? { rolledBackTo: e.fromVersion } : {}),
      at: e.at,
    }).catch((err) => logger.warn('N38 not sent', { remediationId: row.id, error: errorMessage(err) }));
  }
  return updated;
}

export function createInternalRemediationRoutes(): Router {
  const router = Router();
  router.post(
    contractRoute(C, MOUNT),
    requireInternalService({ callers: [...C.callers] }) as RequestHandler,
    (async (req, res) => {
      const p = parseContractParams(C, req);
      if (!p.ok) return sendBadRequest(res, contractErrorMessage(p), ErrorCode.VALIDATION_ERROR);
      const b = parseContractBody(C, req);
      if (!b.ok) return sendBadRequest(res, contractErrorMessage(b), ErrorCode.VALIDATION_ERROR);
      try {
        const row = await applyRolloutReport(p.value.remediationId, b.value as RolloutReport);
        if (!row) return sendError(res, 404, 'Remediation not found', ErrorCode.NOT_FOUND);
        return sendSuccess(res, 200, { remediationId: row.id, stage: row.stage });
      } catch (err) {
        logger.warn('Remediation rollout report failed', { remediationId: p.value.remediationId, error: errorMessage(err) });
        return sendError(res, 500, 'Report not recorded', ErrorCode.INTERNAL_ERROR);
      }
    }) as RequestHandler,
  );
  return router;
}
