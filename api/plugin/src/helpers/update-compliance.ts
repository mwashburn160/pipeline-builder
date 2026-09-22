// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Fail-closed compliance re-check for plugin UPDATES, shared by the single-row
 * (`PUT /plugins/:id`) and bulk (`PUT /plugins/bulk/update`) routes so an edit
 * can't turn a compliant plugin non-compliant through either door.
 */

import { createComplianceClient, errorMessage, getServiceAuthHeader } from '@pipeline-builder/api-core';

import { storedComplianceImageFacts } from './plugin-compliance.js';
import type { Plugin } from '../services/plugin-service.js';

const complianceClient = createComplianceClient();

/**
 * Editable fields whose change can alter a plugin's compliance posture:
 * `visibility`, and the inventory `tags` (CIS 2.1) derived from `keywords` and
 * `labels`. The execution contract is not editable on update, so a
 * descriptive-only edit (summary, links, README, lifecycle, …) keeps the same
 * posture and shouldn't pay a round-trip or be blocked by a compliance outage.
 */
export const COMPLIANCE_RELEVANT_FIELDS = ['visibility', 'keywords', 'labels'] as const;

/** Whether `updateData` touches a compliance-relevant field. */
export function needsComplianceRecheck(updateData: Record<string, unknown>): boolean {
  return COMPLIANCE_RELEVANT_FIELDS.some((f) => f in updateData);
}

export type UpdateComplianceVerdict =
  | { outcome: 'allowed' }
  | { outcome: 'blocked'; violations: unknown[] }
  | { outcome: 'unavailable'; error: string };

/**
 * Validate `existing` as it WOULD look after applying `updateData`. Never throws:
 * an unreachable compliance service is reported as `unavailable` so the caller
 * can reject (fail-closed). `name`/`version` are immutable on update — they key
 * the pushed registry image.
 */
export async function checkUpdateCompliance(
  orgId: string,
  existing: Plugin,
  updateData: Record<string, unknown>,
): Promise<UpdateComplianceVerdict> {
  const serviceAuth = getServiceAuthHeader({ serviceName: 'plugin', orgId, role: 'member' });
  const val = <T>(k: string, fallback: T): T => (k in updateData ? updateData[k] as T : fallback);
  // The stored image's real facts (signed / scanned / vuln* / runAsRoot) and
  // the edited inventory tags; `packages` stays deferred (evaluated post-build).
  const facts = storedComplianceImageFacts({
    ...existing,
    keywords: val('keywords', existing.keywords),
    labels: val('labels', existing.labels),
  });
  try {
    const result = await complianceClient.validatePlugin(orgId, {
      name: existing.name,
      version: existing.version,
      pluginType: existing.pluginType,
      computeType: existing.computeType,
      timeout: existing.timeout,
      failureBehavior: existing.failureBehavior,
      env: existing.env,
      buildArgs: existing.buildArgs,
      installCommands: existing.installCommands,
      commands: existing.commands,
      visibility: val('visibility', existing.visibility),
      secrets: existing.secrets,
      metadata: existing.metadata,
      keywords: val('keywords', existing.keywords),
      buildType: existing.buildType,
      ...facts.attributes,
    }, serviceAuth, existing.id, existing.name, 'update', facts.deferredFields);
    return result.blocked ? { outcome: 'blocked', violations: result.violations } : { outcome: 'allowed' };
  } catch (err) {
    return { outcome: 'unavailable', error: errorMessage(err) };
  }
}
