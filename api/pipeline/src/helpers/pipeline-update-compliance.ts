// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { RULE_FIELDS, createComplianceClient, errorMessage, getServiceAuthHeader, pickRuleAttributes } from '@pipeline-builder/api-core';

const complianceClient = createComplianceClient();

type ValidateResult = Awaited<ReturnType<typeof complianceClient.validatePipeline>>;

/** The existing-row fields the compliance re-check reads. */
/** The stored pipeline an update starts from: its id, plus whatever rule-readable columns the caller has. */
export interface ComplianceCheckedPipeline {
  id: string;
  pipelineName?: string | null;
  [column: string]: unknown;
}

/** Outcome of the fail-closed compliance re-check for one pipeline update. */
export type UpdateComplianceVerdict =
  | { status: 'ok' }
  | { status: 'blocked'; violations: ValidateResult['violations'] }
  | { status: 'unavailable'; error: string };

/** The stored pipeline columns a rule can read (`pipelineName`, `props`, `ownerId`, …). */
const RULE_READABLE_COLUMNS: readonly string[] = [...new Set(RULE_FIELDS.pipeline.filter((f) => !f.derived).map((f) => f.path.split('.')[0]!))];

/**
 * Whether an update can change the pipeline's compliance posture: it touches a
 * column some rule can read. An edit to anything else (links, active flag)
 * doesn't pay a compliance round-trip or get blocked by a compliance outage.
 */
export function isComplianceRelevantUpdate(update: Record<string, unknown>): boolean {
  return RULE_READABLE_COLUMNS.some((column) => update[column] !== undefined);
}

/**
 * Compliance re-check on UPDATE (fail-closed), shared by the single PUT and the
 * bulk update so neither can turn a compliant pipeline non-compliant (create
 * already gates this; without it, edits were a detective-only hole).
 *
 * Evaluates the pipeline AS IT WILL BE: the update's values where present,
 * the existing row's otherwise. A compliance-service failure is `unavailable`
 * — the caller must reject the update, never let it through unchecked.
 * Callers gate on {@link isComplianceRelevantUpdate} first.
 */
export async function checkPipelineUpdateCompliance(
  orgId: string,
  existing: ComplianceCheckedPipeline,
  update: Record<string, unknown>,
): Promise<UpdateComplianceVerdict> {
  const serviceAuth = getServiceAuthHeader({ serviceName: 'pipeline', orgId, role: 'member' });
  const resolvedName = (update.pipelineName ?? existing.pipelineName) as string | undefined;
  try {
    const defined = Object.fromEntries(Object.entries(update).filter(([, v]) => v !== undefined));
    const result = await complianceClient.validatePipeline(orgId, pickRuleAttributes('pipeline', { ...existing, ...defined }), serviceAuth, existing.id, resolvedName, 'update');
    return result.blocked ? { status: 'blocked', violations: result.violations } : { status: 'ok' };
  } catch (err) {
    return { status: 'unavailable', error: errorMessage(err) };
  }
}
