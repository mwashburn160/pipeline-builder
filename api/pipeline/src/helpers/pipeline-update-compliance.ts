// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createComplianceClient, errorMessage, getServiceAuthHeader } from '@pipeline-builder/api-core';

const complianceClient = createComplianceClient();

type ValidateResult = Awaited<ReturnType<typeof complianceClient.validatePipeline>>;

/** The existing-row fields the compliance re-check reads. */
export interface ComplianceCheckedPipeline {
  id: string;
  project: string;
  organization: string;
  pipelineName?: string | null;
  props?: unknown;
  visibility?: string | null;
}

/** Outcome of the fail-closed compliance re-check for one pipeline update. */
export type UpdateComplianceVerdict =
  | { status: 'ok' }
  | { status: 'blocked'; violations: ValidateResult['violations'] }
  | { status: 'unavailable'; error: string };

/**
 * Whether an update can change the pipeline's compliance posture. Only config
 * (`props`) and `visibility` do — a metadata- or name-only edit doesn't, so it
 * doesn't pay a compliance round-trip or get blocked by a compliance outage.
 */
export function isComplianceRelevantUpdate(update: { props?: unknown; visibility?: unknown }): boolean {
  return update.props !== undefined || update.visibility !== undefined;
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
  update: { pipelineName?: unknown; props?: unknown; visibility?: unknown },
): Promise<UpdateComplianceVerdict> {
  const serviceAuth = getServiceAuthHeader({ serviceName: 'pipeline', orgId, role: 'member' });
  const resolvedName = (update.pipelineName ?? existing.pipelineName) as string | undefined;
  try {
    const result = await complianceClient.validatePipeline(orgId, {
      project: existing.project,
      organization: existing.organization,
      pipelineName: resolvedName,
      props: update.props ?? existing.props,
      visibility: update.visibility ?? existing.visibility,
    }, serviceAuth, existing.id, resolvedName, 'update');
    return result.blocked ? { status: 'blocked', violations: result.violations } : { status: 'ok' };
  } catch (err) {
    return { status: 'unavailable', error: errorMessage(err) };
  }
}
