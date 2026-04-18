// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Rule operator evaluation functions.
 *
 * Each operator takes a field value from the entity and a rule value,
 * returning true if the condition is MET (no violation) or false if VIOLATED.
 */

import type { RuleOperator } from '@mwashburn160/pipeline-core';

const MAX_REGEX_LENGTH = 200;

/**
 * Safely compile and test a regex pattern with length limits.
 * Returns false (violation) if pattern is invalid or too long.
 */
function safeRegexTest(pattern: string, value: string): boolean {
  if (pattern.length > MAX_REGEX_LENGTH) return false;
  try {
    const regex = new RegExp(pattern);
    return regex.test(value);
  } catch {
    return false;
  }
}

/**
 * Get a nested value from an object using dot-notation path.
 *
 * Supports computed field prefixes for derived values:
 * - `$count(field)` — array length or object key count
 * - `$length(field)` — string character length
 * - `$keys(field)` — object keys as string array
 * - `$lines(field)` — line count of a string field
 *
 * @param entity - The entity object to extract from
 * @param fieldPath - Dot-notation path (e.g., "props.stages") or computed prefix (e.g., "$count(secrets)")
 * @returns The resolved value, or undefined if the path doesn't exist
 *
 * @example
 * getFieldValue({ a: { b: 1 } }, 'a.b')        // → 1
 * getFieldValue({ arr: [1,2,3] }, '$count(arr)') // → 3
 * getFieldValue({ s: 'hello' }, '$length(s)')    // → 5
 */
export function getFieldValue(entity: Record<string, unknown>, fieldPath: string): unknown {
  // Handle computed fields: $count(field), $length(field), $keys(field), $lines(field)
  const computedMatch = fieldPath.match(/^\$(\w+)\((.+)\)$/);
  if (computedMatch) {
    const [, fn, innerPath] = computedMatch;
    const v = getFieldValue(entity, innerPath);
    const computedFns: Record<string, (val: unknown) => unknown> = {
      count: (val) => Array.isArray(val) ? val.length : (val && typeof val === 'object') ? Object.keys(val).length : 0,
      length: (val) => typeof val === 'string' ? val.length : 0,
      keys: (val) => (val && typeof val === 'object' && !Array.isArray(val)) ? Object.keys(val) : [],
      lines: (val) => typeof val === 'string' ? val.split('\n').length : 0,
    };
    return computedFns[fn]?.(v);
  }

  // Standard dot-notation traversal
  const parts = fieldPath.split('.');
  let current: unknown = entity;

  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    if (typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }

  return current;
}

/**
 * Evaluate a single operator against field and rule values.
 *
 * @param operator - The comparison operator to apply
 * @param fieldValue - The actual value from the entity
 * @param ruleValue - The expected value from the rule definition
 * @returns `true` if the condition is SATISFIED (no violation), `false` if VIOLATED
 *
 * @example
 * evaluateOperator('eq', 'CodeBuildStep', 'CodeBuildStep')  // → true
 * evaluateOperator('gt', 100, 50)                           // → true
 * evaluateOperator('in', 'SMALL', ['SMALL', 'MEDIUM'])      // → true
 * evaluateOperator('regex', 'hello-world', '^hello')        // → true
 */
/** Check if fieldValue contains ruleValue (string or array). */
function evalContains(fieldValue: unknown, ruleValue: unknown): boolean {
  if (typeof fieldValue === 'string' && typeof ruleValue === 'string') {
    return fieldValue.toLowerCase().includes(ruleValue.toLowerCase());
  }
  if (Array.isArray(fieldValue)) {
    return fieldValue.some((v) => String(v).toLowerCase() === String(ruleValue).toLowerCase());
  }
  return false;
}

/** Operator lookup table — each entry returns true if condition is SATISFIED. */
const OPERATORS: Record<string, (fv: unknown, rv: unknown) => boolean> = {
  // Equality
  eq: (fv, rv) => fv === rv || String(fv) === String(rv),
  neq: (fv, rv) => fv !== rv && String(fv) !== String(rv),
  // String / array containment
  contains: evalContains,
  notContains: (fv, rv) => !evalContains(fv, rv),
  // Regex
  regex: (fv, rv) => typeof rv === 'string' && safeRegexTest(rv, String(fv ?? '')),
  // Numeric comparison
  gt: (fv, rv) => Number(fv) > Number(rv),
  gte: (fv, rv) => Number(fv) >= Number(rv),
  lt: (fv, rv) => Number(fv) < Number(rv),
  lte: (fv, rv) => Number(fv) <= Number(rv),
  // Set membership
  in: (fv, rv) => Array.isArray(rv) && rv.some((v) => String(v) === String(fv)),
  notIn: (fv, rv) => !Array.isArray(rv) || !rv.some((v) => String(v) === String(fv)),
  // Existence
  exists: (fv) => fv !== null && fv !== undefined,
  notExists: (fv) => fv === null || fv === undefined,
  // Count/length aliases (used with computed $count/$length fields)
  countGt: (fv, rv) => Number(fv) > Number(rv),
  countLt: (fv, rv) => Number(fv) < Number(rv),
  lengthGt: (fv, rv) => Number(fv) > Number(rv),
  lengthLt: (fv, rv) => Number(fv) < Number(rv),
};

export function evaluateOperator(
  operator: RuleOperator,
  fieldValue: unknown,
  ruleValue: unknown,
): boolean {
  return OPERATORS[operator]?.(fieldValue, ruleValue) ?? false; // Unknown operator = violation (fail-closed)
}

/**
 * Validate that a regex pattern is safe to use.
 *
 * Checks for:
 * - Maximum length (200 chars)
 * - Nested quantifiers that could cause ReDoS (e.g., `(a+)+`)
 * - Valid regex syntax
 *
 * @param pattern - The regex pattern string to validate
 * @returns Error message if unsafe, `null` if safe
 */
export function validateRegexPattern(pattern: string): string | null {
  if (pattern.length > MAX_REGEX_LENGTH) {
    return `Regex pattern exceeds maximum length of ${MAX_REGEX_LENGTH} characters`;
  }

  // Reject known dangerous patterns (nested quantifiers like (a+)+, (a*)*b, etc.)
  if (/(\+|\*|\{[^}]+\})\s*\)?\s*(\+|\*|\{[^}]+\})/.test(pattern)) {
    return 'Regex pattern contains nested quantifiers which may cause performance issues';
  }

  try {
    new RegExp(pattern);
    return null;
  } catch (err) {
    return `Invalid regex pattern: ${err instanceof Error ? err.message : String(err)}`;
  }
}

/**
 * Validate all regex patterns in a rule body (single-field operator + cross-field conditions).
 * Returns an error message string if any pattern is invalid, null if all are valid.
 */
export function validateRuleRegexPatterns(body: {
  operator?: string;
  value?: unknown;
  conditions?: Array<{ field: string; operator: string; value?: unknown }>;
}): string | null {
  if (body.operator === 'regex' && typeof body.value === 'string') {
    const err = validateRegexPattern(body.value);
    if (err) return err;
  }
  if (body.conditions) {
    for (const c of body.conditions) {
      if (c.operator === 'regex' && typeof c.value === 'string') {
        const err = validateRegexPattern(c.value);
        if (err) return `Condition "${c.field}": ${err}`;
      }
    }
  }
  return null;
}
