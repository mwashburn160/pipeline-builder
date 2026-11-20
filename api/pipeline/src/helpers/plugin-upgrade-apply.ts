// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The per-pipeline body of `POST /pipelines/plugin-upgrades/apply`, shared by
 * that route (actor = the user) and the nightly CVE remediation rollout
 * (actor = SYSTEM_PLUGIN_REMEDIATION, helpers/remediation-rollout.ts), so every
 * move of a plugin version goes through ONE write path:
 *
 *   template validation + plugin contracts → compliance re-check (fail-closed)
 *   → conditional update (optimistic on the row the move was computed from)
 *   → resolution recording → `pipeline.plugin.upgraded` audit → optional
 *   redeploy through the org's runner under the duplicate window.
 */

import { actorId, ConcurrencyConflictError, createLogger, errorMessage, recordAudit } from '@pipeline-builder/api-core';
import type { QueuedRunRequestDto } from '@pipeline-builder/api-core/pipeline-runners';
import { checkPipelineUpdateCompliance } from './pipeline-update-compliance.js';
import { complianceBlockedDetails, validatePipelineWrite } from './pipeline-write.js';
import { recordPipelineResolution } from './plugin-contract-check.js';
import type { PluginWarning } from './plugin-save-check.js';
import type { AppliedUpgrade } from './plugin-upgrades.js';
import { DUPLICATE_TRIGGER_MESSAGE, queuedRunRequestDto, triggerExecutionInWindow } from './trigger-execution.js';
import { RunnerRouteError } from '../runners/routing.js';
import { pipelineService, type Pipeline } from '../services/pipeline-service.js';

const logger = createLogger('plugin-upgrade-apply');

export const INTERNAL_UPGRADE_ERROR = 'The upgrade failed because of an internal error; try again.';
export const INTERNAL_REDEPLOY_ERROR = 'The redeploy could not be started because of an internal error; run the pipeline again from its page.';

/**
 * What a per-pipeline failure tells the client: a runner refusal or a
 * concurrent edit keeps its own (user-facing) message; anything else is
 * logged and answered with `fallback` — a driver, SQL or network error's text
 * never reaches the response.
 */
export function clientError(err: unknown, fallback: string, pipelineId: string): string {
  if (err instanceof RunnerRouteError || err instanceof ConcurrencyConflictError) return err.message;
  logger.warn('Plugin upgrade step failed', { pipelineId, error: errorMessage(err) });
  return fallback;
}

/** A queued redeploy (its `requestId` is what the remediation rollout watches), or why none was. */
export type RedeployOutcome = QueuedRunRequestDto | { error: string };

/** Per-pipeline apply outcome. */
export type ApplyOutcome =
  | { pipelineId: string; status: 'upgraded'; applied: AppliedUpgrade[]; pluginWarnings?: PluginWarning[]; redeploy?: RedeployOutcome }
  | { pipelineId: string; status: 'unchanged' }
  | { pipelineId: string; status: 'failed'; error: string };

/** Who an apply runs as. */
export interface ApplyActor {
  /** The audit actor and the row's `updatedBy`: a user id, or a system principal (SYSTEM_PLUGIN_REMEDIATION). */
  userId: string;
  /** `requestedBy` of a redeploy's signed run request. */
  requestedBy: string;
}

/**
 * Start a run of `pipelineId` (its synth re-reads the config) through the same
 * duplicate window as `POST /:id/executions`, auditing `pipeline.execution.start`.
 * A system-initiated start queues past the org's pending cap. Never throws.
 */
export async function redeployPipeline(input: {
  pipelineId: string;
  orgId: string;
  parentOrgId?: string;
  actor: ApplyActor;
  batchId: string;
  reason: string;
  /** Extra audit details (e.g. the remediation id). */
  details?: Record<string, unknown>;
}): Promise<RedeployOutcome> {
  const { pipelineId: id, orgId, parentOrgId, actor, batchId, reason, details = {} } = input;
  try {
    const started = await triggerExecutionInWindow(id, orgId, { requestedBy: actor.requestedBy, ...(parentOrgId ? { parentOrgId } : {}) });
    if (started.status === 'duplicate') {
      recordAudit({
        action: 'pipeline.execution.start',
        actorId: actorId({ userId: actor.userId }),
        orgId,
        targetType: 'pipeline_execution',
        outcome: 'failure',
        details: { pipelineId: id, reason: 'duplicate_suppressed', batchId, ...details },
      });
      return { error: DUPLICATE_TRIGGER_MESSAGE };
    }
    // The dispatcher audits the terminal outcome.
    const { run } = started;
    recordAudit({
      action: 'pipeline.execution.start',
      actorId: actorId({ userId: actor.userId }),
      orgId,
      targetType: 'pipeline_execution',
      details: run.reused
        ? { pipelineId: id, reason, batchId, reusedRequestId: run.requestId, runnerId: run.runnerId, outcome: 'reused', ...details }
        : { pipelineId: id, reason, batchId, requestId: run.requestId, runnerId: run.runnerId, attempts: 0, outcome: 'queued', ...details },
    });
    return queuedRunRequestDto(run);
  } catch (err) {
    recordAudit({
      action: 'pipeline.execution.start',
      actorId: actorId({ userId: actor.userId }),
      orgId,
      targetType: 'pipeline_execution',
      outcome: 'failure',
      details: { pipelineId: id, reason, batchId, ...details },
    });
    return { error: clientError(err, INTERNAL_REDEPLOY_ERROR, id) };
  }
}

/** Input to {@link applyUpgradeToPipeline}. */
export interface ApplyUpgradeInput {
  pipelineId: string;
  orgId: string;
  parentOrgId?: string;
  actor: ApplyActor;
  /** The per-row write gate (the route's visibility ladder); omitted = allowed (a system move). */
  canWrite?: (existing: Pipeline) => boolean;
  /** The rewrite, computed from the row as loaded (so the conditional update is against that row). */
  plan: (existing: Pipeline) => Promise<{ props: Record<string, unknown>; applied: AppliedUpgrade[] }>;
  redeploy: boolean;
  batchId: string;
  /** Extra `pipeline.plugin.upgraded` audit details (route: `widen`; remediation: `remediationId`). */
  auditDetails?: Record<string, unknown>;
  /** `pipeline.execution.start` reason (route: `plugin-upgrade`). */
  redeployReason?: string;
}

/** One pipeline through the normal write path (see the module doc). Never throws. */
export async function applyUpgradeToPipeline(input: ApplyUpgradeInput): Promise<ApplyOutcome> {
  const { pipelineId: id, orgId, parentOrgId, actor, redeploy, batchId, auditDetails = {} } = input;
  try {
    const existing = await pipelineService.findById(id, orgId) as Pipeline | null;
    if (!existing) return { pipelineId: id, status: 'failed', error: 'Pipeline not found' };
    if (input.canWrite && !input.canWrite(existing)) return { pipelineId: id, status: 'failed', error: 'You cannot modify this pipeline' };

    const { props, applied } = await input.plan(existing);
    if (applied.length === 0) return { pipelineId: id, status: 'unchanged' };

    // The normal write path: templates + plugin contracts, then compliance (fail-closed).
    const check = await validatePipelineWrite({ props } as never, orgId, parentOrgId, id, existing);
    if (check.rejection) return { pipelineId: id, status: 'failed', error: check.rejection.message };
    const verdict = await checkPipelineUpdateCompliance(orgId, existing, { props });
    if (verdict.status === 'blocked') {
      recordAudit({
        action: 'pipeline.plugin.upgraded',
        actorId: actorId({ userId: actor.userId }),
        orgId,
        targetType: 'pipeline',
        targetId: id,
        outcome: 'failure',
        details: { pipelineName: existing.pipelineName, ...auditDetails, changes: applied, redeploy, batchId, ...complianceBlockedDetails(verdict.violations) },
      });
      return { pipelineId: id, status: 'failed', error: `Compliance blocked: ${verdict.violations.map((v) => v.message).join('; ')}` };
    }
    if (verdict.status === 'unavailable') {
      return { pipelineId: id, status: 'failed', error: 'Compliance service unavailable — pipeline update rejected' };
    }

    // Conditional on the row the upgrade was computed from: `props` is
    // `existing.props` rewritten, so an edit that landed since the read
    // would otherwise be silently overwritten by the stale config. A moved
    // row fails this pipeline (ConcurrencyConflictError), never the rest.
    const updated = await pipelineService.update(id, { props } as never, orgId, actor.userId, { expectedUpdatedAt: existing.updatedAt ?? undefined });
    if (!updated) return { pipelineId: id, status: 'failed', error: 'Pipeline not found' };
    // Awaited: the moved-off versions' references are gone before the response
    // (and before any plugin delete that follows it).
    await recordPipelineResolution(id, orgId, parentOrgId, updated.props);

    recordAudit({
      action: 'pipeline.plugin.upgraded',
      actorId: actorId({ userId: actor.userId }),
      orgId,
      targetType: 'pipeline',
      targetId: id,
      details: { pipelineName: updated.pipelineName, ...auditDetails, changes: applied, redeploy, batchId },
    });

    const redeployOutcome = redeploy
      ? await redeployPipeline({
        pipelineId: id,
        orgId,
        ...(parentOrgId ? { parentOrgId } : {}),
        actor,
        batchId,
        reason: input.redeployReason ?? 'plugin-upgrade',
        ...(auditDetails.remediationId ? { details: { remediationId: auditDetails.remediationId } } : {}),
      })
      : undefined;
    return {
      pipelineId: id,
      status: 'upgraded',
      applied,
      ...(check.pluginWarnings.length > 0 ? { pluginWarnings: check.pluginWarnings } : {}),
      ...(redeployOutcome ? { redeploy: redeployOutcome } : {}),
    };
  } catch (err) {
    return { pipelineId: id, status: 'failed', error: clientError(err, INTERNAL_UPGRADE_ERROR, id) };
  }
}
