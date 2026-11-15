// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Fail-closed compliance re-check for plugin UPDATES, shared by the single-row
 * (`PUT /plugins/:id`) and bulk (`PUT /plugins/bulk/update`) routes so an edit
 * can't turn a compliant plugin non-compliant through either door.
 */

import { RULE_FIELDS, createComplianceClient, errorMessage, getServiceAuthHeader, pickRuleAttributes } from '@pipeline-builder/api-core';

import { storedComplianceImageFacts } from './plugin-compliance.js';
import type { Plugin } from '../services/plugin-service.js';

const complianceClient = createComplianceClient();

/**
 * The stored plugin columns a rule can read. An edit touching one can alter the
 * plugin's compliance posture (`description`, `visibility`, the inventory
 * `tags` derived from `keywords` and `labels`, …); a descriptive-only edit
 * (summary, links, README, lifecycle) keeps it and shouldn't pay a round-trip
 * or be blocked by a compliance outage.
 */
const RULE_READABLE_COLUMNS: readonly string[] = [...new Set(RULE_FIELDS.plugin.filter((f) => !f.derived).map((f) => f.path.split('.')[0]!))];

/** Whether `updateData` touches a column some rule can read. */
export function needsComplianceRecheck(updateData: Record<string, unknown>): boolean {
  return RULE_READABLE_COLUMNS.some((f) => updateData[f] !== undefined);
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
  const edited = Object.fromEntries(Object.entries(updateData).filter(([, v]) => v !== undefined));
  const after = { ...existing, ...edited };
  // The stored image's real facts (signed / scanned / vuln* / runAsRoot) and
  // the edited inventory tags; `packages` stays deferred (evaluated post-build).
  const facts = storedComplianceImageFacts(after);
  try {
    const result = await complianceClient.validatePlugin(orgId, {
      ...pickRuleAttributes('plugin', after),
      // Immutable on update: they key the pushed registry image.
      name: existing.name,
      version: existing.version,
      ...facts.attributes,
    }, serviceAuth, existing.id, existing.name, 'update', facts.deferredFields);
    return result.blocked ? { outcome: 'blocked', violations: result.violations } : { outcome: 'allowed' };
  } catch (err) {
    return { outcome: 'unavailable', error: errorMessage(err) };
  }
}
