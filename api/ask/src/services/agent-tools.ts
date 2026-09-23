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

/** Build the agent's tools. Every tool acts as the calling user (token-forwarded). */
export function buildAgentTools(deps: AgentToolDeps): ToolSet {
  return {
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

    // Phase 1 — diagnosis (plus the original catalog reads).
    ...diagnoseTools(deps),
    // Phase 2 — policy awareness.
    ...complianceTools(deps),
    // The create proposals (each now compliance-checked; templates validated).
    ...createTools(deps),
    // Phase 3 — edit proposals.
    ...editTools(deps),
    // Phase 4 — remediation into the org's existing approval queues.
    ...remediationTools(deps),
    // Phase 5 — org settings, behind the shared allowlist.
    ...orgSettingsTools(deps),
  };
}
