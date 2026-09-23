// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Policy-aware drafting.
 *
 * The platform's differentiator is policy-as-code, and an agent that drafts in
 * ignorance of it is worse than useless: the user asks for a pipeline, gets a
 * confident draft, presses Apply and the create 403s on a rule the assistant
 * never read.
 *
 * `check_compliance` puts the org's own rule set in front of the model, and
 * `checkDraft` is called by every propose tool before it returns — so a draft
 * comes back either COMPLIANT or with the conflicting rule NAMED on the card.
 *
 * Read-only by construction: it posts to `/compliance/validate/{target}/dry-run`,
 * which the compliance service defines as "no audit, no notifications" — the
 * non-dry-run leg writes a compliance-check log row and can fire a block
 * notification to the org, which a draft has no business doing.
 */

import { tool } from '@pipeline-builder/ai-core';
import type { ToolSet } from '@pipeline-builder/ai-core';
import { z } from 'zod';

import type { ComplianceFinding, ComplianceNote } from '../proposals.js';
import type { AgentToolDeps } from '../tool-deps.js';
import { asArray, asRecord, unwrap } from '../tool-helpers.js';

/** What the compliance service answers a dry-run with. */
interface DryRunResult {
  passed?: boolean;
  blocked?: boolean;
  violations?: unknown[];
  warnings?: unknown[];
  rulesEvaluated?: number;
  rulesSkipped?: number;
}

/** Cap on findings carried back — a card lists, it does not dump. */
const MAX_FINDINGS = 20;

/**
 * Keep the four fields that identify a rule and say what it wants. Dropped:
 * `expectedValue` / `actualValue`, which echo arbitrary slices of the document
 * back into the model's context for no diagnostic gain (design rule 5).
 */
function shapeFindings(raw: unknown[]): ComplianceFinding[] {
  return raw.slice(0, MAX_FINDINGS).map((v) => {
    const f = asRecord(v);
    return {
      ...(typeof f.ruleId === 'string' ? { ruleId: f.ruleId } : {}),
      ...(typeof f.ruleName === 'string' ? { ruleName: f.ruleName } : {}),
      ...(typeof f.severity === 'string' ? { severity: f.severity } : {}),
      message: typeof f.message === 'string' ? f.message : 'Rule violated',
    };
  });
}

/**
 * Dry-run a draft against the org's rules. NEVER throws and never fails the
 * tool that called it: a compliance outage must not turn "here is your draft,
 * unchecked" into "the assistant broke". It comes back `checked: false` with the
 * reason named, and the card says the draft is unverified.
 */
export async function checkDraft(
  deps: Pick<AgentToolDeps, 'compliance'>,
  target: 'pipeline' | 'plugin',
  attributes: Record<string, unknown>,
): Promise<ComplianceNote> {
  try {
    const res = await deps.compliance.post(`/compliance/validate/${target}/dry-run`, { attributes });
    const data = unwrap<DryRunResult>(res) ?? {};
    const violations = shapeFindings(asArray(data.violations));
    const warnings = shapeFindings(asArray(data.warnings));
    return {
      checked: true,
      compliant: data.blocked !== true && violations.length === 0,
      blocked: data.blocked === true,
      violations,
      warnings,
      rulesEvaluated: typeof data.rulesEvaluated === 'number' ? data.rulesEvaluated : undefined,
      rulesSkipped: typeof data.rulesSkipped === 'number' ? data.rulesSkipped : undefined,
    };
  } catch (err) {
    return {
      checked: false,
      compliant: false,
      blocked: false,
      violations: [],
      warnings: [],
      unavailable: err instanceof Error ? err.message : 'compliance dry-run unavailable',
    };
  }
}

/** Attributes a drafted PIPELINE is judged on — the same shape the create route sends. */
export function pipelineAttributes(props: unknown, orgId: string): Record<string, unknown> {
  const p = asRecord(props);
  return {
    project: p.project,
    organization: p.organization ?? orgId,
    pipelineName: p.pipelineName,
    props: p,
    visibility: 'private',
  };
}

/**
 * Attributes a drafted PLUGIN is judged on: its spec. The image facts
 * (`signed`, `scanned`, `vuln*`, `runAsRoot`, `packages`) do not exist until the
 * async build has pushed and scanned the image, so rules reading them are judged
 * against absent values here and are re-checked for real by the build worker.
 * That is what `rulesSkipped` in the note is for.
 */
export function pluginAttributes(config: unknown): Record<string, unknown> {
  return { ...asRecord(config), visibility: 'private' };
}

/** The `check_compliance` read tool. */
export function complianceTools(deps: AgentToolDeps): ToolSet {
  return {
    check_compliance: tool({
      description:
        "Dry-run a pipeline or plugin configuration against the organization's compliance rules and report "
        + 'which rules it violates. READ-ONLY: it records nothing and notifies nobody. Use it before answering '
        + '"would this be allowed?", and to explain a blocked create. Image facts (signed/scanned/vulnerability '
        + 'counts) are unknown until a plugin has been built, so rules reading them are counted in rulesSkipped.',
      inputSchema: z.object({
        target: z.enum(['pipeline', 'plugin']).describe('Which rule set to evaluate against'),
        attributes: z
          .record(z.string(), z.any())
          .describe('The configuration to judge: a pipeline props document, or a plugin spec'),
      }),
      // The caller's org is NOT an input — the dry-run is scoped by the
      // forwarded user token, so the rules evaluated are always the
      // authenticated org's (and its parent's inherited ones), never an org the
      // model names.
      execute: async ({ target, attributes }) => {
        const note = await checkDraft(deps, target, target === 'pipeline'
          ? pipelineAttributes(asRecord(attributes).props ?? attributes, deps.orgId)
          : pluginAttributes(attributes));
        return { compliance: note };
      },
    }),
  };
}
