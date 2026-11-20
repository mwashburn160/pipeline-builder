// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Remediation side effects shared by the queueing pass, the job, the routes and
 * the internal report: audit entries (`plugin.remediation.*`, targetType
 * `plugin_remediation`, details carry names, versions, stage, outcome, advisory
 * ids and counts — never source, diff text or logs), the bounded metrics, and
 * the owner request (N39). Every notice and metric is a no-op when the operator
 * knob is off.
 */

import {
  createLogger,
  errorMessage,
  PLUGIN_REMEDIATION_METRICS,
  recordAudit,
  SYSTEM_PLUGIN_REMEDIATION,
  type PluginRemediationOutcome,
  type PluginRemediationStage,
  type RemediationRemainingFinding,
} from '@pipeline-builder/api-core';
import { incCounter } from '@pipeline-builder/api-server';
import type { PluginRemediation } from '@pipeline-builder/pipeline-data';

import { updateRemediation } from './store.js';
import { sendRemediationNotice } from '../remediation-notices.js';

const logger = createLogger('plugin-remediation');

export type RemediationAuditAction =
  | 'plugin.remediation.started' | 'plugin.remediation.published' | 'plugin.remediation.needs_owner'
  | 'plugin.remediation.approved' | 'plugin.remediation.rejected' | 'plugin.remediation.retried';

/** Record one remediation audit entry (never throws). */
export function auditRemediation(action: RemediationAuditAction, row: PluginRemediation, details: Record<string, unknown> = {}, actorId: string = SYSTEM_PLUGIN_REMEDIATION): void {
  try {
    recordAudit({
      action,
      actorId,
      orgId: row.orgId,
      targetType: 'plugin_remediation',
      targetId: row.id,
      details: {
        pluginName: row.pluginName,
        pluginId: row.pluginId,
        fromVersion: row.fromVersion,
        stage: row.stage,
        ...(row.outcome ? { outcome: row.outcome } : {}),
        ...(row.toVersion ? { toVersion: row.toVersion } : {}),
        attempt: row.attempt,
        ...details,
      },
    });
  } catch (err) {
    logger.warn('Remediation audit failed', { remediationId: row.id, action, error: errorMessage(err) });
  }
}

/** `plugin_remediations_total{stage,outcome}` (outcome `none` while not terminal). */
export function countStage(stage: PluginRemediationStage, outcome: PluginRemediationOutcome | null): void {
  incCounter(PLUGIN_REMEDIATION_METRICS.remediations, { stage, outcome: outcome ?? 'none' });
}

/** `plugin_remediation_findings_cleared_total{type}`. */
export function countCleared(row: Pick<PluginRemediation, 'cleared'>): void {
  for (const c of row.cleared ?? []) incCounter(PLUGIN_REMEDIATION_METRICS.findingsCleared, { type: c.packageType });
}

/** Advisory ids of a findings list (audit details: ids only). */
export const advisoryIds = (list: ReadonlyArray<{ id: string }>): string[] => [...new Set(list.map((f) => f.id))].sort().slice(0, 200);

/**
 * The owner request (N39) for what is left, once per remediation, and its
 * `plugin.remediation.needs_owner` audit. Never throws.
 */
export async function sendOwnerRequest(row: PluginRemediation, remaining: RemediationRemainingFinding[], uploaderId: string | null): Promise<void> {
  if (remaining.length === 0 || row.ownerRequestSentAt) return;
  try {
    await sendRemediationNotice({
      code: 'N39',
      orgId: row.orgId,
      remediationId: row.id,
      pluginName: row.pluginName,
      fromVersion: row.fromVersion,
      toVersion: row.toVersion,
      remaining,
      uploaderId,
    });
    await updateRemediation(row.id, { ownerRequestSentAt: new Date() });
  } catch (err) {
    logger.warn('Owner request not sent', { remediationId: row.id, error: errorMessage(err) });
  }
  auditRemediation('plugin.remediation.needs_owner', row, {
    remaining: remaining.map((r) => ({ id: r.id, packageName: r.packageName, reason: r.reason, ...(r.requiredLevel ? { requiredLevel: r.requiredLevel } : {}) })).slice(0, 200),
  });
}
