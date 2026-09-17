// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Fail-closed compliance re-check for plugin UPDATES, shared by the single-row
 * (`PUT /plugins/:id`) and bulk (`PUT /plugins/bulk/update`) routes so an edit
 * can't turn a compliant plugin non-compliant through either door.
 */

import { createComplianceClient, errorMessage, getServiceAuthHeader } from '@pipeline-builder/api-core';

import type { Plugin } from '../services/plugin-service.js';

const complianceClient = createComplianceClient();

/**
 * Execution/config fields whose change can alter a plugin's compliance posture.
 * A change to any of these triggers re-validation; a catalog-metadata-only edit
 * (description/labels/lifecycle/isActive/isDefault) keeps the same posture and
 * shouldn't pay a round-trip or be blocked by a compliance outage.
 */
export const COMPLIANCE_RELEVANT_FIELDS = [
  'pluginType', 'computeType', 'timeout', 'failureBehavior', 'env', 'buildArgs',
  'installCommands', 'commands', 'visibility', 'secrets',
] as const;

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
  try {
    const result = await complianceClient.validatePlugin(orgId, {
      name: existing.name,
      version: existing.version,
      pluginType: val('pluginType', existing.pluginType),
      computeType: val('computeType', existing.computeType),
      timeout: val('timeout', existing.timeout),
      failureBehavior: val('failureBehavior', existing.failureBehavior),
      env: val('env', existing.env),
      buildArgs: val('buildArgs', existing.buildArgs),
      installCommands: val('installCommands', existing.installCommands),
      commands: val('commands', existing.commands),
      visibility: val('visibility', existing.visibility),
      secrets: val('secrets', existing.secrets),
      metadata: val('metadata', existing.metadata),
      keywords: val('keywords', existing.keywords),
    }, serviceAuth, existing.id, existing.name, 'update');
    return result.blocked ? { outcome: 'blocked', violations: result.violations } : { outcome: 'allowed' };
  } catch (err) {
    return { outcome: 'unavailable', error: errorMessage(err) };
  }
}
