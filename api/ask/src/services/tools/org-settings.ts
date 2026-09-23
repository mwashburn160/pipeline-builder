// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Organization settings.
 *
 * The one place a BESPOKE confirm gate is warranted, because unlike installs and
 * exemptions there is no existing approval queue to file into: an org setting is
 * changed by one admin, immediately. So the whole weight falls on the allowlist
 * and on the diff — and neither lives here.
 *
 * `@pipeline-builder/api-core/ask-proposals` is the single policy, imported by
 * this tool's INPUT SCHEMA, by the browser's confirm handler and by both sides'
 * tests. This module contributes no list of its own: it reads the current
 * values, hands the model's candidate to `pickAllowed`, diffs with
 * `diffOrgSettings`, and plans the commit with `orgSettingRequests`. Adding a
 * proposable setting is an edit to that module and nothing else.
 *
 * Which is exactly how design rule 1 is meant to work, and why the fields that
 * are NOT there — MFA / password / authenticator / impersonation policy, SSO and
 * its group mappings, verified domains, owner transfer, team lifecycle, the
 * install policy, AI provider credentials, every webhook URL and secret, every
 * recipient list, and the org's own name and slug — are ABSENT rather than
 * gated. There is no code path here that could be argued into reaching them.
 *
 * The org is ALWAYS the authenticated caller's (`deps.orgId`). There is no orgId
 * input for a crafted message to set.
 */

import { tool } from '@pipeline-builder/ai-core';
import type { ToolSet } from '@pipeline-builder/ai-core';
import {
  ORG_SETTING_PROPOSAL_ALLOWLIST,
  ORG_SETTING_PROPOSAL_KEYS,
  diffOrgSettings,
  orgSettingRequests,
  pickAllowed,
} from '@pipeline-builder/api-core';
import type { OrgSettingKey, OrgSettingPatch, OrgSettingSpec, OrgSettingSurface, OrgSettingValue } from '@pipeline-builder/api-core';
import { z } from 'zod';

import type { DeclinedProposal, OrgSettingsProposal } from '../proposals.js';
import { ASK_PROVENANCE, declined } from '../proposals.js';
import type { AgentToolDeps } from '../tool-deps.js';
import { asRecord, settle, unwrap } from '../tool-helpers.js';

/** One allowlist row's declared domain, as a zod schema. */
function schemaFor(spec: OrgSettingSpec): z.ZodTypeAny {
  const shape = spec.shape;
  if (shape.kind === 'boolean') return z.boolean();
  if (shape.kind === 'integer') return z.number().int().min(shape.min).max(shape.max);
  return z.enum([...shape.values] as [string, ...string[]]);
}

/**
 * The tool's `changes` schema, BUILT FROM the shared allowlist — so a field
 * becomes proposable by being added there, and nowhere else. `catchall` keeps
 * unknown keys rather than silently stripping them, because `pickAllowed` has to
 * SEE an invented field to report it as the injection signal (design rule 10).
 */
const ChangesSchema = z
  .object(Object.fromEntries(ORG_SETTING_PROPOSAL_ALLOWLIST.map((spec) => [
    spec.key,
    schemaFor(spec).optional().describe(`${spec.label}. ${spec.why}`),
  ])))
  .catchall(z.any());

/** Where each surface's CURRENT values are read from, with the user's token. */
const SURFACE_READS: Record<OrgSettingSurface, { client: keyof Pick<AgentToolDeps, 'reporting' | 'compliance' | 'plugin'>; path: string; envelope: string }> = {
  reporting: { client: 'reporting', path: '/reports/settings/incidents', envelope: 'settings' },
  complianceNotifications: { client: 'compliance', path: '/compliance/notification-preferences', envelope: 'preference' },
  pluginSecurityNotifications: { client: 'plugin', path: '/plugins/security-notifications', envelope: 'preferences' },
};

/** Only the surfaces the candidate actually touches are read. */
function surfacesOf(keys: readonly OrgSettingKey[]): OrgSettingSurface[] {
  const out = new Set<OrgSettingSurface>();
  for (const spec of ORG_SETTING_PROPOSAL_ALLOWLIST) if (keys.includes(spec.key)) out.add(spec.surface);
  return [...out];
}

export function orgSettingsTools(deps: AgentToolDeps): ToolSet {
  const { orgId, onRefusedFields } = deps;

  return {
    propose_org_settings: tool({
      description:
        "Propose a change to the organization's settings. Returns a reviewable before/after diff; nothing is "
        + 'changed until an admin applies it. ONLY these settings can be proposed: '
        + `${ORG_SETTING_PROPOSAL_KEYS.join(', ')}. Security settings (MFA, password and authenticator policy, `
        + 'impersonation, SSO/SAML and group mappings, verified domains, ownership transfer, team lifecycle, '
        + 'the plugin install policy, AI provider credentials) CANNOT be proposed by this assistant at all — '
        + 'tell the user to change those themselves in Settings. Neither can webhook URLs or secrets, '
        + "notification recipient lists, data-retention limits, or the organization's name and slug.",
      inputSchema: z.object({
        // NOTE: there is deliberately no `organizationId` input. The org is the
        // authenticated caller's, injected from the request below, so a
        // prompt-injected message cannot retarget another tenant's settings.
        changes: ChangesSchema.describe('Only the settings to change, keyed by their full `<surface>.<field>` name'),
        reason: z.string().max(500).optional().describe('One sentence: what this change does and why'),
      }),
      execute: async ({ changes, reason }): Promise<OrgSettingsProposal | DeclinedProposal> => {
        // Rules 1, 3 and 10 in one call: keep the allowlisted, shape-valid
        // fields; report the unknown ones (injection signal) and the
        // out-of-domain ones (drafting mistake) separately.
        const picked = pickAllowed(changes);
        const refusedFields = [...picked.refused];
        if (refusedFields.length > 0) onRefusedFields('propose_org_settings', refusedFields);

        const wanted = Object.keys(picked.allowed) as OrgSettingKey[];
        if (wanted.length === 0) {
          const why = refusedFields.length > 0
            ? `None of those settings can be proposed by the assistant. Proposable: ${ORG_SETTING_PROPOSAL_KEYS.join(', ')}.`
            : picked.invalid.length > 0
              ? `Those values are outside what the settings accept: ${picked.invalid.join(', ')}.`
              : 'No proposable setting was named.';
          return { ...declined('org-settings-edit', why), refusedFields };
        }

        // CURRENT values, read with the caller's token from the owning service.
        // Settled: an admin who can change the reporting window but holds no
        // `compliance:read` still gets a usable diff for the half they can see.
        const reads = await Promise.all(surfacesOf(wanted).map(async (surface) => {
          const read = SURFACE_READS[surface];
          const result = await settle(async () => unwrap<Record<string, unknown>>(await deps[read.client].get(read.path)));
          const row = result.ok ? asRecord(asRecord(result.value)[read.envelope] ?? result.value) : {};
          return [surface, row] as const;
        }));
        const rows = new Map<OrgSettingSurface, Record<string, unknown>>(reads);

        const current: OrgSettingPatch = {};
        for (const spec of ORG_SETTING_PROPOSAL_ALLOWLIST) {
          const value = rows.get(spec.surface)?.[spec.field];
          if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
            current[spec.key] = value;
          }
        }

        // A field whose CURRENT value could not be read has no baseline, so the
        // confirm handler could not verify state had not moved before applying
        // (design rule 7). Drop it rather than ship a diff whose "before" is a
        // guess.
        const readable = wanted.filter((key) => current[key] !== undefined);
        const unreadable = wanted.filter((key) => current[key] === undefined);
        const proposedPatch: OrgSettingPatch = Object.fromEntries(readable.map((k) => [k, picked.allowed[k] as OrgSettingValue]));

        const settingChanges = diffOrgSettings(current, proposedPatch);
        if (settingChanges.length === 0) {
          const why = unreadable.length === wanted.length
            ? `Could not read the current value of: ${unreadable.join(', ')}. Nothing was proposed, because an edit with no verifiable baseline cannot be safely applied.`
            : 'Those settings already have the requested values — nothing to change.';
          return { ...declined('org-settings-edit', why), refusedFields };
        }

        return {
          kind: 'org-settings-edit',
          id: orgId,
          target: orgId,
          changedFields: settingChanges.map((c) => c.spec.key),
          current: Object.fromEntries(settingChanges.map((c) => [c.spec.key, c.from ?? null])),
          proposed: Object.fromEntries(settingChanges.map((c) => [c.spec.key, c.to])),
          labels: Object.fromEntries(settingChanges.map((c) => [c.spec.key, c.spec.label])),
          // The commit payload: one request per surface, already translated back
          // to each API's own field names. The UI sends these and only these.
          requests: orgSettingRequests(settingChanges),
          refusedFields,
          invalidFields: [...picked.invalid],
          unreadableFields: unreadable,
          description: reason,
          provenance: ASK_PROVENANCE,
        };
      },
    }),
  };
}
