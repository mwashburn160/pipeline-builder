// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The plugin service's glue around the shared vulnerability assessment (api-core
 * `assessVersionVulns`, which `/plugins/lookup`, `/plugins/runtime-check` and the
 * pipeline service's save-time contract check all run): loading the org's
 * effective consumption policy, and a PIPELINE's risk acceptances when the
 * caller names a pipeline its org owns. The assessment grades; it never refuses.
 */

import {
  assessVersionVulns, type ScannedRecord, type VersionVulnAssessment, type VulnAcceptance,
} from '@pipeline-builder/api-core';
import {
  acceptanceKey, activeAcceptances, effectiveConsumptionPolicy, executeRows, scopeOrgIds, withTenantTx,
  type ConsumptionPolicy, type PipelineAcceptances,
} from '@pipeline-builder/pipeline-data';
import { sql } from 'drizzle-orm';
import { listingSource } from '../services/ecosystem/installs-store.js';

/** The org's effective consumption policy (a team's merged with its root's). */
export async function consumptionPolicyFor(scope: { orgId: string; rootOrgId?: string }): Promise<ConsumptionPolicy> {
  const orgIds = scopeOrgIds(scope);
  return effectiveConsumptionPolicy(await listingSource.policiesForOrgs(orgIds), orgIds[0]!, orgIds[1]);
}

/** A live pipeline of `orgId` (id + name), or null — the ownership check every pipeline-scoped call starts with. */
export async function ownedPipeline(orgId: string, pipelineId: string): Promise<{ id: string; name: string | null } | null> {
  if (!/^[0-9a-f-]{36}$/i.test(pipelineId)) return null;
  const rows = await withTenantTx((tx) => executeRows<{ id: string; pipeline_name: string | null }>(tx, sql`
    SELECT id::text AS id, pipeline_name FROM pipelines
     WHERE id::text = ${pipelineId} AND lower(org_id) = ${orgId.toLowerCase()} AND deleted_at IS NULL
  `));
  return rows[0] ? { id: rows[0].id, name: rows[0].pipeline_name } : null;
}

/** No acceptances (a caller without a pipeline context). */
export const NO_ACCEPTANCES: PipelineAcceptances = { byKey: new Map(), versionsByPlugin: new Map() };

/** The pipeline's acceptance of one resolved version / image, or null. */
export function acceptanceFor(acceptances: PipelineAcceptances, record: { name: string; version: string; imageDigest?: unknown }): VulnAcceptance | null {
  if (acceptances.byKey.size === 0) return null;
  const digest = typeof record.imageDigest === 'string' ? record.imageDigest : null;
  return acceptances.byKey.get(acceptanceKey(record.name, record.version, digest)) ?? null;
}

/** The pipeline's active acceptances, or none for a caller without a pipeline. */
export async function acceptancesFor(orgId: string, pipelineId: string | null): Promise<PipelineAcceptances> {
  return pipelineId ? activeAcceptances(orgId, pipelineId) : NO_ACCEPTANCES;
}

/** The assessment of one resolved record for the caller's org (and pipeline, when it named one). */
export function assessmentFor(input: {
  orgId: string;
  record: ScannedRecord;
  policy: ConsumptionPolicy;
  acceptances: PipelineAcceptances;
  suggestedVersion?: string | null;
  compliance?: boolean;
}): Promise<VersionVulnAssessment> {
  return assessVersionVulns({
    orgId: input.orgId,
    record: input.record,
    policy: input.policy,
    acceptance: acceptanceFor(input.acceptances, input.record),
    ...(input.suggestedVersion ? { suggestedVersion: input.suggestedVersion } : {}),
    ...(input.compliance === false ? { compliance: false } : {}),
  });
}
