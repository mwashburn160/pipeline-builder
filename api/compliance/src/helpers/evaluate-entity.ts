// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Evaluate one entity against a set of rules the way enforcement does.
 *
 * Every path that evaluates rules (the live validate route, async entity
 * events, scheduled scans, the rule-impact preview) must see the same derived
 * fields and the same severity handling, or a preview tells an admin one thing
 * and enforcement does another. The impact preview did exactly that: it skipped
 * both derivations, so every image plugin previewed as unsigned and every
 * `stepFacts` rule as failing all pipelines.
 *
 * - A STORED plugin row gets its image facts (`signed`, `scanned`, …). A live
 *   payload from the plugin service already carries them, so it doesn't.
 * - A pipeline gets its `stepFacts` when a rule reads them.
 * - Rules reading vulnerability state are enforced as warnings on pipelines.
 */

import type { RuleTarget } from '@pipeline-builder/api-core';
import { asNonBlockingVulnRules, rulesReadStepFacts, withPipelineStepFacts } from './pipeline-step-facts.js';
import { withPluginImageFacts } from './plugin-image-attributes.js';
import { evaluateRules, type ActiveExemption, type EvaluableRule, type RuleValidationResult } from '../engine/rule-engine.js';

export interface EvaluateEntityInput<R extends EvaluableRule> {
  target: RuleTarget;
  rules: readonly R[];
  attributes: Record<string, unknown>;
  orgId: string;
  parentOrgId?: string;
  /** The attributes are a stored plugin row, not a live payload that carries its image facts. */
  storedPlugin?: boolean;
  exemptions?: ActiveExemption[];
  /** Attributes the caller already knows it can't evaluate yet. */
  deferredFields?: readonly string[];
}

export interface EvaluatedEntity {
  result: RuleValidationResult;
  /** What the rules saw: the input plus its derived fields. */
  attributes: Record<string, unknown>;
  deferredFields: string[];
}

export async function evaluateEntity<R extends EvaluableRule>(input: EvaluateEntityInput<R>): Promise<EvaluatedEntity> {
  const { target, rules, orgId, parentOrgId } = input;
  let attributes = input.attributes;
  const deferredFields = [...(input.deferredFields ?? [])];

  if (target === 'plugin' && input.storedPlugin) {
    const derived = withPluginImageFacts(attributes);
    attributes = derived.attributes;
    deferredFields.push(...derived.deferredFields);
  }
  if (target === 'pipeline' && rulesReadStepFacts(rules)) {
    const derived = await withPipelineStepFacts(attributes, orgId, parentOrgId);
    attributes = derived.attributes;
    deferredFields.push(...derived.deferredFields);
  }

  const enforced = target === 'pipeline' ? asNonBlockingVulnRules(rules) : [...rules];
  const result = evaluateRules(enforced, attributes, input.exemptions ?? [], deferredFields);
  return { result, attributes, deferredFields };
}
