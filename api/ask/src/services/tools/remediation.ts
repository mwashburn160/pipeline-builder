// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Remediation through the org's EXISTING approval workflows.
 *
 * The platform already has two human-approval queues, with their own
 * permissions, their own notifications and their own audit trail:
 *
 *   plugin installs      POST /plugins/installs/:id/change-requests   `plugins:install`
 *                        …/approve | …/reject                        `plugin_installs:manage`
 *   compliance exemptions POST /compliance/exemptions                 `compliance:read`
 *                        PUT  /compliance/exemptions/:id/review       `compliance:write`
 *
 * A remediation the agent suggests belongs in THOSE queues — visible to
 * approvers who were never in the conversation, with the existing audit trail —
 * not in a chat panel where it evaporates when the drawer closes. So neither
 * tool invents a confirm gate; both produce a proposal whose commit target IS
 * the real queue endpoint.
 *
 * WHY THESE STILL ONLY PROPOSE. Filing a change request is a WRITE: it stores a
 * pending change on the install row, emits `plugin.install.change-request` to
 * the audit trail and sends N11 to every approver. Filing an exemption request
 * is a WRITE: it inserts a pending row and notifies. Neither POST is itself the
 * human-approval step — approval is a SEPARATE endpoint, decided by a different
 * capability, and compliance even blocks self-approval (`CE_SELF_APPROVE`). So
 * "the request endpoint is the approval gate" is false for both, and the
 * invariant holds unchanged: the agent proposes, the user's own session files
 * it, and only then does a second human approve it.
 */

import { tool } from '@pipeline-builder/ai-core';
import type { ToolSet } from '@pipeline-builder/ai-core';
import { z } from 'zod';

import type { CommitTarget, DeclinedProposal, ExemptionRequestProposal, InstallChangeProposal } from '../proposals.js';
import { ASK_PROVENANCE, declined } from '../proposals.js';
import type { AgentToolDeps } from '../tool-deps.js';
import { ResourceId } from '../tool-deps.js';
import { asArray, asRecord, changedPaths, settle, unwrap } from '../tool-helpers.js';

/** Approval-gated: the change goes into the org's queue for someone else to decide. */
const INSTALL_CHANGE_REQUEST: CommitTarget = {
  service: 'plugin', method: 'POST', path: '/plugins/installs/:id/change-requests', permission: 'plugins:install',
};
/** Not gated for this caller: the same change applies directly, with the same permission. */
const INSTALL_DIRECT: CommitTarget = {
  service: 'plugin', method: 'PATCH', path: '/plugins/installs/:id', permission: 'plugins:install',
};
const EXEMPTION_REQUEST: CommitTarget = {
  service: 'compliance', method: 'POST', path: '/compliance/exemptions', permission: 'compliance:read',
};

/** A version string the model supplies. Semver-ish; never lands in a URL path. */
const VersionString = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/, 'must be a version string');

/** A UUID the model supplies (compliance keys rules and entities by UUID). */
const Uuid = z.string().uuid();

/**
 * Both tools take typed, enumerated inputs rather than a free-form `changes`
 * object, so the input schema IS the allowlist and there is no off-allowlist
 * field for a model to smuggle in — which is why neither calls
 * `onRefusedFields`, and why `refusedFields` is always empty here.
 */
export function remediationTools(deps: AgentToolDeps): ToolSet {
  const { plugin, compliance } = deps;

  return {
    propose_install_change: tool({
      description:
        'Propose moving a plugin install to a different version or version policy — the remediation for an '
        + 'install that diagnose_installs found on a flagged or advised version. Returns a reviewable '
        + "before/after diff; applying it files the change into the organization's OWN approval queue (or "
        + 'applies it directly when this member needs no approver), never into this chat. Find the install id '
        + 'with diagnose_installs first.',
      inputSchema: z.object({
        installId: ResourceId.describe('The install id (from diagnose_installs)'),
        version: VersionString.optional().describe('The version to move to; omit to only change the policy'),
        versionPolicy: z.enum(['exact', 'patch', 'minor', 'latest']).optional().describe("The install's version policy"),
        note: z.string().max(1000).optional().describe('A note for the approver: why this change is needed'),
      }),
      execute: async ({ installId, version, versionPolicy, note }): Promise<InstallChangeProposal | DeclinedProposal> => {
        if (version === undefined && versionPolicy === undefined) {
          return declined('install-change-request', 'Name a version, a version policy, or both — there is nothing to change otherwise.');
        }

        const read = await settle(async () => unwrap<{ installs?: unknown[] }>(await plugin.get('/plugins/installs')));
        if (!read.ok) return declined('install-change-request', `Could not read the org's installs: ${read.reason}`);

        const row = asArray(read.value?.installs).map(asRecord).find((i) => i.id === installId);
        if (!row) return declined('install-change-request', `No install ${installId} in this organization.`);
        if (row.status !== 'active') {
          return declined('install-change-request', `That install is ${String(row.status)}; only an active install can be changed.`);
        }
        if (row.pendingChange) {
          return declined('install-change-request', 'That install already has a change waiting for approval.');
        }

        const currentVersion = (row.pinnedVersion ?? row.resolvedVersion ?? null) as string | null;
        const currentPolicy = row.versionPolicy ?? 'minor';
        const current: Record<string, unknown> = {};
        const proposed: Record<string, unknown> = {};
        const changedFields: string[] = [];
        if (version !== undefined && version !== currentVersion) {
          changedFields.push('version');
          current.version = currentVersion;
          proposed.version = version;
        }
        if (versionPolicy !== undefined && versionPolicy !== currentPolicy) {
          changedFields.push('versionPolicy');
          current.versionPolicy = currentPolicy;
          proposed.versionPolicy = versionPolicy;
        }
        if (changedFields.length === 0) {
          return declined('install-change-request', 'The install is already on that version and policy.');
        }

        // An approval-gated change goes to the queue; an ungated one is refused
        // BY the queue endpoint ("this change needs no approval; apply it with
        // PATCH"), so the commit target follows the caller's standing.
        const gated = row.needsApproval === true;
        const advisories = asArray(row.advisories).map(asRecord);

        return {
          kind: 'install-change-request',
          id: installId,
          target: `${String(row.publisherHandle)}/${String(row.name)}`,
          changedFields,
          current,
          proposed,
          changedPaths: changedFields.flatMap((f) => changedPaths(current[f], proposed[f], f)),
          commit: gated ? INSTALL_CHANGE_REQUEST : INSTALL_DIRECT,
          note,
          clears: advisories.map((a) => ({
            id: typeof a.id === 'string' ? a.id : undefined,
            severity: typeof a.severity === 'string' ? a.severity : undefined,
            summary: typeof a.summary === 'string' ? a.summary : undefined,
            fixedVersion: (a.fixedVersion ?? null) as string | null,
          })),
          description: gated
            ? "Files a change request into the organization's install-approval queue; an approver decides."
            : 'Applies directly — this member needs no approver for this install.',
          refusedFields: [],
          provenance: ASK_PROVENANCE,
        };
      },
    }),

    propose_compliance_exemption: tool({
      description:
        'Propose requesting an exemption from one compliance rule for one pipeline or plugin — the '
        + 'remediation when check_compliance shows a rule blocking something the org has a real reason to '
        + "allow. Returns a reviewable request; applying it files it into the organization's OWN exemption "
        + 'queue, where an ADMIN reviews it (the requester can never approve their own). Nothing is exempt '
        + 'until that review. Use check_compliance first to get the ruleId.',
      inputSchema: z.object({
        ruleId: Uuid.describe('The compliance rule to be exempt from (from check_compliance)'),
        entityType: z.enum(['pipeline', 'plugin']).describe('What kind of entity the exemption covers'),
        entityId: Uuid.describe('The pipeline or plugin the exemption covers'),
        reason: z.string().min(1).max(2000).describe("The justification the reviewer will read — the user's reason, not an invented one"),
        expiresAt: z.string().datetime().optional().describe('ISO-8601 expiry; omit for no expiry'),
        entityName: z.string().max(255).optional().describe('Display name of the entity, if known'),
      }),
      execute: async ({ ruleId, entityType, entityId, reason, expiresAt, entityName }): Promise<ExemptionRequestProposal | DeclinedProposal> => {
        // Read the rule so the card names what is being waived, rather than
        // asking a reviewer to approve a bare UUID. A rule the caller's org
        // cannot see is a rule they cannot be exempt from.
        const read = await settle(async () => unwrap<{ rule?: unknown }>(await compliance.get(`/compliance/rules/${encodeURIComponent(ruleId)}`)));
        if (!read.ok) return declined('compliance-exemption-request', `Could not read rule ${ruleId}: ${read.reason}`);
        const rule = asRecord(asRecord(read.value).rule ?? read.value);

        // An exemption is only meaningful against a rule that is actually
        // enforcing. Naming an inactive one would file a request for nothing.
        if (rule.isActive === false) {
          return declined('compliance-exemption-request', `Rule "${String(rule.name ?? ruleId)}" is not active, so nothing is being blocked by it.`);
        }

        const ruleName = String(rule.name ?? ruleId);
        return {
          kind: 'compliance-exemption-request',
          target: entityName ? `${ruleName} — ${entityName}` : ruleName,
          request: {
            ruleId,
            entityType,
            entityId,
            ...(entityName ? { entityName } : {}),
            reason,
            ...(expiresAt ? { expiresAt } : {}),
          },
          commit: EXEMPTION_REQUEST,
          description: `Requests an exemption from "${ruleName}"${typeof rule.severity === 'string' ? ` (${rule.severity})` : ''}. An org admin other than the requester must approve it before it takes effect.`,
          refusedFields: [],
          provenance: ASK_PROVENANCE,
        };
      },
    }),
  };
}
