// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

// Tool set for the "Ask" agent's tool-calling loop. All tools are READ or
// PROPOSE — none of them writes. A propose tool either calls a service's
// `/generate` endpoint (forwarding the user's token) or drafts in process, and
// returns a DRAFT; the actual create/update/request is a separate, explicit user
// action in the UI (confirm gate), committed through the user's own session.
// So the agent can never mutate anything.
//
// That holds for the remediation tools too, even though they target endpoints
// the platform already treats as "requests": filing a change request or an
// exemption request IS a write (a stored pending row, an audit event and a
// notification to approvers), and the approval is a SEPARATE endpoint decided by
// a different capability. See `tools/remediation.ts` for the full reasoning.
//
// Every tool acts as the CALLING USER via their forwarded bearer token, so each
// owning service re-checks permissions, tenancy, compliance and quota exactly as
// it would for that user's own request. `orgId` is injected from the
// authenticated caller and is never a model input.

import { ASK_PROPOSAL_PERMISSION, orgSettingSpec, type AskProposalKind, type Permission } from '@pipeline-builder/api-core';
import { buildGroundingContext, tool } from '@pipeline-builder/ai-core';
import type { ToolSet } from '@pipeline-builder/ai-core';
import { z } from 'zod';

import type { AgentToolDeps } from './tool-deps.js';
import { complianceTools } from './tools/compliance.js';
import { createTools } from './tools/create.js';
import { diagnoseTools } from './tools/diagnose.js';
import { editTools } from './tools/edits.js';
import { orgSettingsTools } from './tools/org-settings.js';
import { remediationTools } from './tools/remediation.js';

export type { AgentToolDeps } from './tool-deps.js';

/**
 * The permissions a drafted proposal needs to COMMIT, from the shared table.
 *
 * `org-settings-edit` has no single answer — its requirement is the union over
 * the allowlist rows it actually touches — so it is derived from the draft's own
 * `changedFields`, the same way the dashboard derives it.
 */
function commitPermissions(output: Record<string, unknown>): Permission[] {
  const kind = output.kind as AskProposalKind | undefined;
  if (!kind || !(kind in ASK_PROPOSAL_PERMISSION)) return [];
  const base = ASK_PROPOSAL_PERMISSION[kind];
  if (base) return [base];
  if (kind !== 'org-settings-edit') return [];
  const fields = Array.isArray(output.changedFields) ? output.changedFields : [];
  const out = new Set<Permission>();
  for (const f of fields) {
    const spec = typeof f === 'string' ? orgSettingSpec(f) : undefined;
    if (spec) out.add(spec.permission);
  }
  return [...out];
}

/**
 * Tell each draft whether the CALLER can apply it.
 *
 * Wrapped once here rather than added to twelve return shapes, so a propose tool
 * added later carries it without anyone remembering to. It rides the TOOL RESULT
 * on purpose: that is what re-enters the model's context, which is what lets the
 * agent finish the thought — "drafted; applying needs `pipelines:write`, which
 * you don't have" — instead of handing back a draft that dead-ends at a
 * greyed-out button.
 *
 * ADVISORY ONLY. Nothing here refuses, and the tools still draft what the caller
 * cannot apply, because a draft they pass to an admin is the point of drafting.
 * Enforcement is unchanged: the commit goes through the user's own session to
 * the owning service, which re-checks.
 */
function withAppliability(tools: ToolSet, holds: (p: Permission) => boolean): ToolSet {
  const out: ToolSet = {};
  for (const [name, t] of Object.entries(tools)) {
    const execute = (t as { execute?: (...a: unknown[]) => Promise<unknown> }).execute;
    if (!name.startsWith('propose_') || typeof execute !== 'function') {
      out[name] = t;
      continue;
    }
    out[name] = {
      ...t,
      execute: async (...args: unknown[]) => {
        const result = await execute(...args);
        if (!result || typeof result !== 'object' || Array.isArray(result)) return result;
        const needed = commitPermissions(result as Record<string, unknown>);
        if (needed.length === 0) return result;
        const missing = needed.filter((perm) => !holds(perm));
        return { ...result, appliable: { ok: missing.length === 0, requires: needed, missing } };
      },
    } as ToolSet[string];
  }
  return out;
}

/** Build the agent's tools. Every tool acts as the calling user (token-forwarded). */
export function buildAgentTools(deps: AgentToolDeps): ToolSet {
  return withAppliability({
    answer_how_to: tool({
      description:
        'Look up platform documentation to answer a how-to or functionality question. '
        + 'Returns grounded context and its sources — call this before answering any "how do I…" question, and answer only from what it returns.',
      inputSchema: z.object({ query: z.string().describe('The question to look up in the docs') }),
      execute: async ({ query }) => {
        const hits = deps.index.search(query, 5);
        return {
          context: buildGroundingContext(hits),
          sources: hits.map((h) => ({ id: h.doc.id, title: h.doc.title, url: h.doc.url })),
        };
      },
    }),

    // Diagnosis + catalog reads.
    ...diagnoseTools(deps),
    // Policy awareness.
    ...complianceTools(deps),
    // Create proposals (each compliance-checked; templates additionally validated).
    ...createTools(deps),
    // Edit proposals.
    ...editTools(deps),
    // Remediation into the org's existing approval queues.
    ...remediationTools(deps),
    // Org settings, behind the shared allowlist.
    ...orgSettingsTools(deps),
  }, deps.holdsPermission);
}
