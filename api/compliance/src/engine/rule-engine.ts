// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Compliance rule engine — evaluates rules against entity attributes.
 *
 * Supports:
 * - Single-field rules (field + operator + value)
 * - Cross-field rules (conditions array with all/any mode)
 * - Dependent rules (dependsOnRule — only evaluate if referenced rule passed)
 * - Computed fields ($count, $length, $keys, $lines)
 * - Exemption skipping
 * - Effective date filtering
 * - Priority ordering (highest priority first)
 */

import type { RuleOperator, RuleSeverity, RuleCondition } from '@pipeline-builder/pipeline-core';
import { evaluateOperator, getFieldValue } from './rule-operators';

/**
 * A compliance rule as stored in the database.
 * Minimal interface — only the fields needed for evaluation.
 */
export interface EvaluableRule {
  id: string;
  name: string;
  policyId?: string | null;
  priority: number;
  target: string;
  severity: RuleSeverity;
  scope: string;
  suppressNotification: boolean;
  effectiveFrom?: Date | null;
  effectiveUntil?: Date | null;

  // Single-field condition
  field?: string | null;
  operator?: RuleOperator | null;
  value?: unknown;

  // Cross-field conditions
  conditions?: RuleCondition[] | null;
  conditionMode?: string | null;
}

/**
 * An active exemption for an entity+rule pair.
 */
export interface ActiveExemption {
  id: string;
  ruleId: string;
}

/**
 * A single rule violation.
 */
export interface Violation {
  ruleId: string;
  ruleName: string;
  policyId?: string | null;
  field: string;
  operator: string;
  expectedValue: unknown;
  actualValue: unknown;
  severity: RuleSeverity;
  message: string;
  suppressNotification: boolean;
}

/**
 * Result of evaluating all rules against an entity.
 */
export interface ValidationResult {
  passed: boolean;
  violations: Violation[];
  warnings: Violation[];
  blocked: boolean;
  rulesEvaluated: number;
  rulesSkipped: number;
  exemptionsApplied: string[];
}

/**
 * Check if a rule is currently effective based on its date range.
 */
function isRuleEffective(rule: EvaluableRule, now: Date): boolean {
  if (rule.effectiveFrom && now < rule.effectiveFrom) return false;
  if (rule.effectiveUntil && now > rule.effectiveUntil) return false;
  return true;
}

/**
 * Evaluate a single rule's conditions against an entity.
 * Returns a Violation if the rule is violated, or null if it passes.
 */
function evaluateSingleRule(
  rule: EvaluableRule,
  entity: Record<string, unknown>,
): Violation | null {
  // Cross-field conditions (overrides single-field)
  if (rule.conditions && rule.conditions.length > 0) {
    return evaluateCrossFieldRule(rule, entity);
  }

  // Single-field condition
  if (!rule.field || !rule.operator) return null; // No condition = passes

  const fieldValue = getFieldValue(entity, rule.field);
  const passed = evaluateOperator(rule.operator, fieldValue, rule.value);

  if (passed) return null;

  return {
    ruleId: rule.id,
    ruleName: rule.name,
    policyId: rule.policyId,
    field: rule.field,
    operator: rule.operator,
    expectedValue: rule.value,
    actualValue: fieldValue,
    severity: rule.severity,
    message: `Field "${rule.field}" failed ${rule.operator} check: expected ${JSON.stringify(rule.value)}, got ${JSON.stringify(fieldValue)}`,
    suppressNotification: rule.suppressNotification,
  };
}

/**
 * Evaluate a cross-field rule with multiple conditions.
 */
function evaluateCrossFieldRule(
  rule: EvaluableRule,
  entity: Record<string, unknown>,
): Violation | null {
  const conditions = rule.conditions!;
  const mode = rule.conditionMode || 'all';

  const results = conditions
    .filter((c) => !c.dependsOnRule && c.field && c.operator) // Skip dependency-only conditions
    .map((condition) => {
      const fieldValue = getFieldValue(entity, condition.field!);
      const passed = evaluateOperator(condition.operator!, fieldValue, condition.value);
      return { condition, fieldValue, passed };
    });

  const allPassed = mode === 'all'
    ? results.every((r) => r.passed)
    : results.some((r) => r.passed);

  if (allPassed) return null;

  // Find the first failing condition for the violation message
  const firstFailure = results.find((r) => !r.passed);
  const failField = firstFailure?.condition.field ?? 'unknown';
  const failOp = firstFailure?.condition.operator ?? 'unknown';

  return {
    ruleId: rule.id,
    ruleName: rule.name,
    policyId: rule.policyId,
    field: failField,
    operator: failOp,
    expectedValue: firstFailure?.condition.value,
    actualValue: firstFailure?.fieldValue,
    severity: rule.severity,
    message: `Cross-field rule "${rule.name}" failed (${mode} mode): ${results.filter((r) => !r.passed).length} of ${results.length} conditions violated`,
    suppressNotification: rule.suppressNotification,
  };
}

/**
 * Evaluate all rules against an entity.
 *
 * @param rules - Active rules for the entity's org+target, sorted by priority DESC
 * @param entity - Entity attributes as key-value pairs
 * @param exemptions - Active exemptions for this entity (optional)
 * @returns ValidationResult with violations, warnings, and pass/block status
 */
export function evaluateRules(
  rules: EvaluableRule[],
  entity: Record<string, unknown>,
  exemptions: ActiveExemption[] = [],
): ValidationResult {
  const now = new Date();
  const violations: Violation[] = [];
  const warnings: Violation[] = [];
  const exemptionsApplied: string[] = [];
  let rulesEvaluated = 0;
  let rulesSkipped = 0;

  // Track which rules passed (for dependent rule evaluation)
  const passedRuleIds = new Set<string>();

  // Sort by priority DESC (highest first)
  const sortedRules = [...rules].sort((a, b) => b.priority - a.priority);

  for (const rule of sortedRules) {
    // Skip rules outside effective date range
    if (!isRuleEffective(rule, now)) {
      rulesSkipped++;
      continue;
    }

    // Check for dependent rules in conditions
    if (rule.conditions?.some((c) => c.dependsOnRule)) {
      const deps = rule.conditions.filter((c) => c.dependsOnRule);
      const allDepsPassed = deps.every((c) => passedRuleIds.has(c.dependsOnRule!));
      if (!allDepsPassed) {
        rulesSkipped++;
        continue;
      }
    }

    // Check exemptions
    const exemption = exemptions.find((e) => e.ruleId === rule.id);
    if (exemption) {
      exemptionsApplied.push(exemption.id);
      rulesSkipped++;
      continue;
    }

    rulesEvaluated++;
    const violation = evaluateSingleRule(rule, entity);

    if (violation) {
      if (violation.severity === 'warning') {
        warnings.push(violation);
      } else {
        violations.push(violation);
      }
    } else {
      passedRuleIds.add(rule.id);
    }
  }

  const blocked = violations.length > 0;

  return {
    passed: !blocked && warnings.length === 0,
    violations,
    warnings,
    blocked,
    rulesEvaluated,
    rulesSkipped,
    exemptionsApplied,
  };
}
