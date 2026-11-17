// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { complianceRuleService } from '../services/compliance-rule-service.js';

/** One requested exemption's rule reference. */
export interface ExemptionRuleRef {
  ruleId: string;
  entityType: string;
}

/** Why a requested exemption's rule cannot be exempted, as the route answers it. */
export type ExemptionRuleRefusal =
  | { status: 400; message: string }
  | { status: 403; message: string };

/** Answered when a team asks to waive a rule its parent organization imposes. */
export const INHERITED_RULE_EXEMPTION_MESSAGE =
  'This rule is inherited from the parent organization, so only the parent organization can waive it.';

/**
 * Check every rule an exemption request names BEFORE it is filed.
 *
 * Without this the id was only shape-checked: an id naming no rule (or a purged
 * one) tripped the `rule_id` foreign key and surfaced as a 500 — failing a whole
 * 500-row bulk import over one bad id — and a soft-deleted or another tenant's
 * rule was filed as a waiver for something this org is not bound by.
 *
 * Accepted: a live, active rule this org OWNS, or a PUBLISHED rule (the
 * subscribable library), whose target matches the entity being exempted.
 * Refused with 403: a rule the caller's PARENT propagates — inherited rules are
 * read-only to a team (edit/delete answer the same 403), and an exemption a team
 * admin approves would otherwise switch the parent's mandate off for that entity
 * with no one in the parent involved.
 */
export async function checkExemptionRules(
  refs: readonly ExemptionRuleRef[],
  orgId: string,
  parentOrgId: string | undefined,
): Promise<ExemptionRuleRefusal | null> {
  const ids = [...new Set(refs.map((r) => r.ruleId.toLowerCase()))];
  // Published rules, plus this org's and its parent's own (any scope) — the only
  // rules the checks below can accept or answer 403 for. Another tenant's
  // private rule is never fetched, so it reads as unknown.
  const lookup = await complianceRuleService.findManyByIds(ids, { alsoOwnedBy: [orgId, parentOrgId] });
  const rules = new Map(lookup.map((r) => [r.id.toLowerCase(), r]));
  for (const ref of refs) {
    const rule = rules.get(ref.ruleId.toLowerCase());
    if (rule && parentOrgId && rule.orgId === parentOrgId && rule.propagateToChildren) {
      return { status: 403, message: INHERITED_RULE_EXEMPTION_MESSAGE };
    }
    const exemptable = rule && (rule.orgId === orgId || rule.scope === 'published');
    if (!exemptable) return { status: 400, message: `Unknown or inactive compliance rule: ${ref.ruleId}` };
    if (rule.target !== ref.entityType) {
      return { status: 400, message: `Rule ${ref.ruleId} applies to ${rule.target}s, not ${ref.entityType}s` };
    }
  }
  return null;
}
